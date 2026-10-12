/**
 * ISO 20022 messages for a sponsored participation in a regional scheme.
 *
 * BitriPay reaches such a scheme as an indirect participant: a sponsoring bank holds the scheme position and
 * exchanges the messages. That exchange is a file exchange here — a credit transfer is built and downloaded, and the
 * answer the sponsor returns is uploaded back — so the platform needs no key, no endpoint and no vendor of its own,
 * exactly like every other rail it runs. When a sponsor offers an interface, the same documents go through it; the
 * message is the contract, not the transport.
 *
 * Four documents are handled:
 *   · pacs.008  built  — the credit transfer BitriPay instructs
 *   · pacs.002  parsed — the status report that accepts or rejects it
 *   · pacs.004  parsed — the return of a transfer that had already settled
 *   · camt.053  parsed — the statement that reconciles the counterparty sub-ledger
 *
 * The party details a scheme requires (full name, address, country, purpose, and a legal-entity identifier for a
 * business payer) are produced from records the platform already keeps. `partyGaps()` says which of them are still
 * missing, so the work of collecting them happens long before a message has to carry them.
 */
import { getDb } from '../../db';
import { uuid, now } from '../../lib/ids';
import { badRequest, notFound } from '../../lib/errors';
import { buildXml, childAt, childrenAt, parseXml, textAt, type XmlElement, type XmlNode } from '../../lib/xml';
import { getCurrency } from '../currencies';
import { recordEvent } from '../events';
import { PURPOSE_CODES } from '../capabilities';
import { getCounterparty, type NetworkCounterparty } from './registry';
import { confirmBatch, failBatch, getBatch, recordCounterpartyMovement, type SettlementBatch } from './positions';
import type { UserRow } from '../users';

export const ISO_MESSAGE_KINDS = ['pacs.008', 'pacs.002', 'pacs.004', 'camt.053'] as const;
export type IsoMessageKind = (typeof ISO_MESSAGE_KINDS)[number];

export const ISO_NAMESPACES: Record<IsoMessageKind, string> = {
  'pacs.008': 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08',
  'pacs.002': 'urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10',
  'pacs.004': 'urn:iso:std:iso:20022:tech:xsd:pacs.004.001.09',
  'camt.053': 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.08',
};

/** The element that carries each document inside <Document>. */
const ROOT_ELEMENT: Record<IsoMessageKind, string> = {
  'pacs.008': 'FIToFICstmrCdtTrf',
  'pacs.002': 'FIToFIPmtStsRpt',
  'pacs.004': 'PmtRtr',
  'camt.053': 'BkToCstmrStmt',
};

export type IsoMessageStatus = 'built' | 'exported' | 'imported' | 'accepted' | 'rejected' | 'returned' | 'applied';

export interface IsoMessage {
  id: string;
  kind: IsoMessageKind;
  direction: 'out' | 'in';
  msgId: string;
  batchId: string | null;
  endToEndId: string | null;
  counterpartyId: string | null;
  currency: string | null;
  amountMinor: number | null;
  status: IsoMessageStatus;
  statusReason: string | null;
  fileName: string | null;
  payload: string;
  createdBy: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface Iso20022Party {
  name: string;
  country?: string | null;
  addressLines?: string[];
  /** Legal-entity identifier, required by most schemes for a business payer. */
  lei?: string | null;
  account?: string | null;
  bic?: string | null;
}

// ------------------------------------------------------------ field hygiene

const MAX_ID = 35;
const MAX_NAME = 140;
const MAX_ADDRESS_LINE = 70;

/** ISO 20022 identifiers are restricted-character, 35 at most; anything else is refused rather than silently cut. */
function assertId(value: string, field: string): string {
  if (!value || value.length > MAX_ID) throw badRequest(`${field} must be 1 to ${MAX_ID} characters.`, 'iso20022_invalid_field');
  if (!/^[A-Za-z0-9+?/\-:().,'\s]+$/.test(value)) throw badRequest(`${field} contains a character ISO 20022 does not allow.`, 'iso20022_invalid_field');
  return value;
}

/** Which scheme-required party details are still missing, so they can be collected before a message needs them. */
export function partyGaps(party: Iso20022Party, opts: { businessPayer?: boolean } = {}): string[] {
  const gaps: string[] = [];
  if (!party.name?.trim()) gaps.push('name');
  if (party.name && party.name.length > MAX_NAME) gaps.push(`name longer than ${MAX_NAME} characters`);
  if (!party.country) gaps.push('country');
  if (!party.addressLines?.length) gaps.push('address');
  if ((party.addressLines ?? []).some((l) => l.length > MAX_ADDRESS_LINE)) gaps.push(`address line longer than ${MAX_ADDRESS_LINE} characters`);
  if (opts.businessPayer && !party.lei) gaps.push('legal-entity identifier');
  if (!party.account) gaps.push('account');
  return gaps;
}

/** The party details of a counterparty, as far as its record goes, with the gaps named. */
export function partyFromCounterparty(cp: NetworkCounterparty, account?: string | null): { party: Iso20022Party; gaps: string[] } {
  const party: Iso20022Party = { name: cp.name, country: cp.country, addressLines: [], lei: null, account: account ?? null };
  return { party, gaps: partyGaps(party, { businessPayer: true }) };
}

function partyElement(tag: string, party: Iso20022Party): XmlElement {
  return {
    name: tag,
    children: [
      {
        name: 'Nm',
        text: party.name.slice(0, MAX_NAME),
      },
      party.addressLines?.length || party.country
        ? {
            name: 'PstlAdr',
            children: [party.country ? { name: 'Ctry', text: party.country } : null, ...(party.addressLines ?? []).map((line) => ({ name: 'AdrLine', text: line.slice(0, MAX_ADDRESS_LINE) }))],
          }
        : null,
      party.lei ? { name: 'Id', children: [{ name: 'OrgId', children: [{ name: 'LEI', text: party.lei }] }] } : null,
    ],
  };
}

function accountElement(tag: string, party: Iso20022Party): XmlElement | null {
  if (!party.account) return null;
  return { name: tag, children: [{ name: 'Id', children: [{ name: 'Othr', children: [{ name: 'Id', text: party.account }] }] }] };
}

function agentElement(tag: string, party: Iso20022Party): XmlElement | null {
  if (!party.bic) return null;
  return { name: tag, children: [{ name: 'FinInstnId', children: [{ name: 'BICFI', text: party.bic }] }] };
}

/** Minor units to the decimal string a scheme expects, using the currency's own exponent. */
export function formatIsoAmount(amountMinor: number, currency: string): string {
  const decimals = getCurrency(currency).decimals ?? 2;
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor)
    .toString()
    .padStart(decimals + 1, '0');
  return decimals === 0 ? `${sign}${abs}` : `${sign}${abs.slice(0, -decimals)}.${abs.slice(-decimals)}`;
}

/** The inverse, used when reading a statement. Refuses a value with more decimals than the currency has. */
export function parseIsoAmount(value: string, currency: string): number {
  const decimals = getCurrency(currency).decimals ?? 2;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw badRequest(`"${value}" is not an amount.`, 'iso20022_invalid_amount');
  const frac = m[3] ?? '';
  if (frac.length > decimals) throw badRequest(`"${value}" has more decimals than ${currency} allows.`, 'iso20022_invalid_amount');
  const minor = Number(m[2]) * 10 ** decimals + Number((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return m[1] === '-' ? -minor : minor;
}

// ----------------------------------------------------------------- storage

function messageRow(r: any): IsoMessage {
  return {
    id: r.id,
    kind: r.kind,
    direction: r.direction,
    msgId: r.msg_id,
    batchId: r.batch_id ?? null,
    endToEndId: r.end_to_end_id ?? null,
    counterpartyId: r.counterparty_id ?? null,
    currency: r.currency ?? null,
    amountMinor: r.amount_minor ?? null,
    status: r.status,
    statusReason: r.status_reason ?? null,
    fileName: r.file_name ?? null,
    payload: r.payload,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    processedAt: r.processed_at ?? null,
  };
}

export function listIsoMessages(filter: { kind?: IsoMessageKind | null; batchId?: string | null; limit?: number } = {}): IsoMessage[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.kind) {
    where.push('kind = ?');
    args.push(filter.kind);
  }
  if (filter.batchId) {
    where.push('batch_id = ?');
    args.push(filter.batchId);
  }
  const sql = `SELECT * FROM network_iso_messages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  return (
    getDb()
      .prepare(sql)
      .all(...args, Math.min(filter.limit ?? 100, 500)) as any[]
  ).map(messageRow);
}

export function getIsoMessage(id: string): IsoMessage {
  const r = getDb().prepare('SELECT * FROM network_iso_messages WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Unknown message', 'iso20022_message_not_found');
  return messageRow(r);
}

function store(input: Omit<IsoMessage, 'id' | 'createdAt' | 'processedAt'>): IsoMessage {
  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO network_iso_messages (id, kind, direction, msg_id, batch_id, end_to_end_id, counterparty_id, currency, amount_minor, status, status_reason, file_name, payload, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.kind,
      input.direction,
      input.msgId,
      input.batchId,
      input.endToEndId,
      input.counterpartyId,
      input.currency,
      input.amountMinor,
      input.status,
      input.statusReason,
      input.fileName,
      input.payload,
      input.createdBy,
      now(),
    );
  return getIsoMessage(id);
}

/** `BP` plus the date and a per-day counter: short, unique, and readable in a sponsor's own system. */
export function nextMessageId(kind: IsoMessageKind, at = new Date()): string {
  const day = at.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `BP${day}`;
  const row = getDb().prepare('SELECT COUNT(*) n FROM network_iso_messages WHERE kind = ? AND msg_id LIKE ?').get(kind, `${prefix}%`) as { n: number };
  return `${prefix}${String(row.n + 1).padStart(5, '0')}`;
}

// ------------------------------------------------------------------ pacs.008

export interface CreditTransferInput {
  batchId: string;
  debtor: Iso20022Party;
  creditor: Iso20022Party;
  purposeCode: string;
  settlementDate?: string;
  remittanceInformation?: string | null;
}

/**
 * Build the credit transfer for a settlement batch. Refuses to build at all when a party detail a scheme requires is
 * missing: a message that would be rejected downstream is better refused here, where the reason is readable.
 */
export function buildCreditTransfer(input: CreditTransferInput, admin: UserRow): IsoMessage {
  const batch = getBatch(input.batchId);
  if (batch.status !== 'approved') throw badRequest('A credit transfer is built for a batch a second administrator has approved.', 'batch_not_approved');
  if (!PURPOSE_CODES.includes(input.purposeCode as (typeof PURPOSE_CODES)[number])) throw badRequest(`Unknown purpose code "${input.purposeCode}".`, 'iso20022_invalid_field');
  const debtorGaps = partyGaps(input.debtor, { businessPayer: true });
  const creditorGaps = partyGaps(input.creditor);
  if (debtorGaps.length || creditorGaps.length) {
    throw badRequest(
      `This message cannot be built yet. Debtor missing: ${debtorGaps.join(', ') || 'nothing'}. Creditor missing: ${creditorGaps.join(', ') || 'nothing'}.`,
      'iso20022_party_incomplete',
      {
        debtor: debtorGaps,
        creditor: creditorGaps,
      },
    );
  }
  const msgId = assertId(nextMessageId('pacs.008'), 'Message identification');
  const endToEndId = assertId(`BATCH${String(batch.number).padStart(6, '0')}`, 'End-to-end identification');
  const settlementDate = input.settlementDate ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(settlementDate)) throw badRequest('The settlement date is a calendar date (YYYY-MM-DD).', 'iso20022_invalid_field');
  const amount = formatIsoAmount(batch.netMinor, batch.currency);

  const doc: XmlElement = {
    name: 'Document',
    attributes: { xmlns: ISO_NAMESPACES['pacs.008'] },
    children: [
      {
        name: ROOT_ELEMENT['pacs.008'],
        children: [
          {
            name: 'GrpHdr',
            children: [
              { name: 'MsgId', text: msgId },
              { name: 'CreDtTm', text: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') },
              { name: 'NbOfTxs', text: '1' },
              { name: 'TtlIntrBkSttlmAmt', attributes: { Ccy: batch.currency }, text: amount },
              { name: 'IntrBkSttlmDt', text: settlementDate },
              { name: 'SttlmInf', children: [{ name: 'SttlmMtd', text: 'CLRG' }] },
            ],
          },
          {
            name: 'CdtTrfTxInf',
            children: [
              {
                name: 'PmtId',
                children: [
                  { name: 'InstrId', text: msgId },
                  { name: 'EndToEndId', text: endToEndId },
                ],
              },
              { name: 'IntrBkSttlmAmt', attributes: { Ccy: batch.currency }, text: amount },
              { name: 'ChrgBr', text: 'SHAR' },
              partyElement('Dbtr', input.debtor),
              accountElement('DbtrAcct', input.debtor),
              agentElement('DbtrAgt', input.debtor),
              agentElement('CdtrAgt', input.creditor),
              partyElement('Cdtr', input.creditor),
              accountElement('CdtrAcct', input.creditor),
              { name: 'Purp', children: [{ name: 'Prtry', text: input.purposeCode }] },
              input.remittanceInformation ? { name: 'RmtInf', children: [{ name: 'Ustrd', text: input.remittanceInformation.slice(0, 140) }] } : null,
            ],
          },
        ],
      },
    ],
  };

  const message = store({
    kind: 'pacs.008',
    direction: 'out',
    msgId,
    batchId: batch.id,
    endToEndId,
    counterpartyId: batch.counterpartyId,
    currency: batch.currency,
    amountMinor: batch.netMinor,
    status: 'built',
    statusReason: null,
    fileName: `pacs.008-${msgId}.xml`,
    payload: buildXml(doc),
    createdBy: admin.id,
  });
  recordEvent('network', message.id, 'network.iso20022.built', { type: 'admin', id: admin.id }, { kind: 'pacs.008', msgId, batch: batch.number, amount: batch.netMinor, currency: batch.currency });
  return message;
}

/** Mark a built message as handed to the sponsor, so the console shows what is already out. */
export function markExported(id: string, admin: UserRow): IsoMessage {
  const m = getIsoMessage(id);
  if (m.direction !== 'out') throw badRequest('Only an outbound message is exported.', 'iso20022_not_outbound');
  getDb().prepare("UPDATE network_iso_messages SET status = 'exported', processed_at = ? WHERE id = ?").run(now(), id);
  recordEvent('network', id, 'network.iso20022.exported', { type: 'admin', id: admin.id }, { kind: m.kind, msgId: m.msgId });
  return getIsoMessage(id);
}

// ------------------------------------------------------- reading an answer

function documentOf(xml: string): { root: XmlNode; kind: IsoMessageKind } {
  const root = parseXml(xml);
  if (root.name !== 'Document') throw badRequest('An ISO 20022 file has <Document> as its root element.', 'iso20022_unknown_document');
  const found = (Object.entries(ROOT_ELEMENT) as [IsoMessageKind, string][]).find(([, element]) => root.children.some((c) => c.name === element));
  if (!found) throw badRequest(`This document carries none of ${ISO_MESSAGE_KINDS.join(', ')}.`, 'iso20022_unknown_document');
  return { root, kind: found[0] };
}

export interface ImportResult {
  message: IsoMessage;
  kind: IsoMessageKind;
  applied: string[];
  warnings: string[];
}

/**
 * Read a file the sponsor returned and act on it: a status report settles or fails its batch, a return posts a
 * return movement and fails the batch, a statement posts the day's entries into the counterparty sub-ledger.
 * Importing the same file twice is safe: every movement is keyed on its own reference.
 */
export function importIsoMessage(xml: string, input: { fileName?: string | null; counterpartyId?: string | null }, admin: UserRow): ImportResult {
  const { root, kind } = documentOf(xml);
  const body = childAt(root, ROOT_ELEMENT[kind])!;
  const msgId = textAt(body, 'GrpHdr/MsgId') ?? `IMPORT-${uuid().slice(0, 8).toUpperCase()}`;
  const duplicate = getDb().prepare('SELECT * FROM network_iso_messages WHERE kind = ? AND msg_id = ?').get(kind, msgId) as any;
  if (duplicate) return { message: messageRow(duplicate), kind, applied: [], warnings: ['This file was already imported; nothing was applied twice.'] };

  const applied: string[] = [];
  const warnings: string[] = [];
  let status: IsoMessageStatus = 'imported';
  let statusReason: string | null = null;
  let counterpartyId = input.counterpartyId ?? null;
  let currency: string | null = null;
  let amountMinor: number | null = null;
  let endToEndId: string | null = null;

  if (kind === 'pacs.002') {
    for (const info of childrenAt(body, 'TxInfAndSts')) {
      const e2e = textAt(info, 'OrgnlEndToEndId');
      const txSts = textAt(info, 'TxSts') ?? '';
      const reason = textAt(info, 'StsRsnInf/Rsn/Cd') ?? textAt(info, 'StsRsnInf/AddtlInf');
      endToEndId = e2e ?? endToEndId;
      const batch = batchForEndToEnd(e2e);
      if (!batch) {
        warnings.push(`No settlement batch matches ${e2e ?? 'a transaction without an end-to-end identification'}.`);
        continue;
      }
      counterpartyId = batch.counterpartyId;
      currency = batch.currency;
      amountMinor = batch.netMinor;
      if (txSts === 'ACSC' || txSts === 'ACCC' || txSts === 'ACSP' || txSts === 'ACCP') {
        if (batch.status === 'instructed') {
          confirmBatch(batch.id, textAt(info, 'OrgnlTxId') ?? msgId, admin.id);
          applied.push(`Batch ${batch.number} confirmed (${txSts}).`);
        } else warnings.push(`Batch ${batch.number} is ${batch.status}; the status report was recorded but changed nothing.`);
        status = 'accepted';
      } else if (txSts === 'RJCT') {
        failBatch(batch.id, reason ? `Rejected by the scheme: ${reason}` : 'Rejected by the scheme', admin.id);
        applied.push(`Batch ${batch.number} failed (${reason ?? 'RJCT'}).`);
        status = 'rejected';
        statusReason = reason;
      } else {
        warnings.push(`Status "${txSts}" on batch ${batch.number} is neither an acceptance nor a rejection; nothing was changed.`);
      }
    }
  } else if (kind === 'pacs.004') {
    for (const info of childrenAt(body, 'TxInf')) {
      const e2e = textAt(info, 'OrgnlEndToEndId');
      endToEndId = e2e ?? endToEndId;
      const batch = batchForEndToEnd(e2e);
      const reason = textAt(info, 'RtrRsnInf/Rsn/Cd') ?? textAt(info, 'RtrRsnInf/AddtlInf') ?? 'returned';
      const amountNode = childAt(info, 'RtrdIntrBkSttlmAmt');
      if (!batch) {
        warnings.push(`No settlement batch matches ${e2e ?? 'a return without an end-to-end identification'}.`);
        continue;
      }
      counterpartyId = batch.counterpartyId;
      currency = batch.currency;
      const returned = amountNode ? parseIsoAmount(amountNode.text, amountNode.attributes.Ccy || batch.currency) : batch.netMinor;
      amountMinor = returned;
      recordCounterpartyMovement(
        {
          counterpartyId: batch.counterpartyId,
          currency: batch.currency,
          kind: 'return',
          amountMinor: Math.abs(returned),
          reference: `RTN-${msgId}-${e2e ?? batch.number}`,
          note: `Return: ${reason}`,
        },
        admin.id,
      );
      if (batch.status !== 'reconciled') failBatch(batch.id, `Returned by the scheme: ${reason}`, admin.id);
      applied.push(`Batch ${batch.number} returned (${reason}).`);
      status = 'returned';
      statusReason = reason;
    }
  } else if (kind === 'camt.053') {
    if (!counterpartyId) throw badRequest('Say which counterparty this statement belongs to.', 'counterparty_required');
    const cp = getCounterparty(counterpartyId);
    for (const stmt of childrenAt(body, 'Stmt')) {
      const stmtCurrency = textAt(stmt, 'Acct/Ccy') ?? cp.currencies[0];
      currency = stmtCurrency;
      if (!cp.currencies.includes(stmtCurrency)) {
        warnings.push(`${cp.name} does not settle in ${stmtCurrency}; those entries were skipped.`);
        continue;
      }
      for (const entry of childrenAt(stmt, 'Ntry')) {
        const amountNode = childAt(entry, 'Amt');
        const indicator = textAt(entry, 'CdtDbtInd');
        const reference = textAt(entry, 'NtryRef') ?? textAt(entry, 'AcctSvcrRef') ?? textAt(entry, 'NtryDtls/TxDtls/Refs/EndToEndId');
        const bookingDate = textAt(entry, 'BookgDt/Dt') ?? textAt(entry, 'BookgDt/DtTm');
        if (!amountNode || !indicator) {
          warnings.push('A statement entry without an amount or a credit/debit indicator was skipped.');
          continue;
        }
        if (!reference) {
          warnings.push('A statement entry without any reference was skipped: there would be no way to recognise it again.');
          continue;
        }
        const entryMinor = parseIsoAmount(amountNode.text, amountNode.attributes.Ccy || stmtCurrency);
        const movementKind = indicator === 'CRDT' ? 'collection' : 'postpaid_payout';
        recordCounterpartyMovement(
          {
            counterpartyId: cp.id,
            currency: stmtCurrency,
            kind: movementKind,
            amountMinor: Math.abs(entryMinor),
            reference,
            occurredAt: bookingDate ? new Date(bookingDate.length === 10 ? `${bookingDate}T00:00:00.000Z` : bookingDate).toISOString() : undefined,
            statementMessageId: msgId,
            note: textAt(entry, 'AddtlNtryInf'),
          },
          admin.id,
        );
        applied.push(`${indicator === 'CRDT' ? 'Collection' : 'Payout'} ${reference}: ${formatIsoAmount(Math.abs(entryMinor), stmtCurrency)} ${stmtCurrency}.`);
      }
    }
    status = 'applied';
  } else {
    throw badRequest('A pacs.008 is built here, not imported.', 'iso20022_unexpected_document');
  }

  const message = store({
    kind,
    direction: 'in',
    msgId,
    batchId: null,
    endToEndId,
    counterpartyId,
    currency,
    amountMinor,
    status,
    statusReason,
    fileName: input.fileName ?? null,
    payload: xml,
    createdBy: admin.id,
  });
  getDb().prepare('UPDATE network_iso_messages SET processed_at = ? WHERE id = ?').run(now(), message.id);
  recordEvent('network', message.id, 'network.iso20022.imported', { type: 'admin', id: admin.id }, { kind, msgId, applied: applied.length, warnings: warnings.length });
  return { message: getIsoMessage(message.id), kind, applied, warnings };
}

function batchForEndToEnd(endToEndId: string | null): SettlementBatch | null {
  if (!endToEndId) return null;
  const m = /^BATCH(\d+)$/.exec(endToEndId);
  const row = m
    ? (getDb().prepare('SELECT id FROM network_settlement_batches WHERE number = ?').get(Number(m[1])) as { id: string } | undefined)
    : (getDb().prepare('SELECT id FROM network_settlement_batches WHERE instruction_ref = ? OR external_ref = ?').get(endToEndId, endToEndId) as { id: string } | undefined);
  if (!row) return null;
  try {
    return getBatch(row.id);
  } catch {
    return null;
  }
}
