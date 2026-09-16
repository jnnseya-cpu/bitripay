import React, { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { Linking, Share, View } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, KV, PinSheet, AmountInput, Row, Status, Tabs, Empty, useAsync, Select, Avatar, Chip } from '../components/ui';
import { Header } from '../components/Header';
import { OperatorPicker, StageBar, ROUTE_STEPS } from './Money';

type Source = 'wallet' | 'card' | 'mobile_money' | 'bank';
type Dest = 'wallet' | 'qr' | 'mobile_money' | 'bank' | 'agent';

/** Any → any: fund from wallet / card / mobile money / bank and deliver to a user, QR code, mobile money number, bank account or agent. */
export function Move() {
  const { t, user, wallets, config, money, toast, refreshWallets } = useStore();
  const [source, setSource] = useState<Source>('wallet');
  const [dest, setDest] = useState<Dest>('wallet');
  const [amount, setAmount] = useState('');
  const [cur, setCur] = useState(wallets[0]?.currency || config?.baseCurrency || 'USD');
  const [target, setTarget] = useState('');
  const [to, setTo] = useState('');
  const [qr, setQr] = useState('');
  const [src, setSrc] = useState({ country: user?.country ?? '', operatorId: '', phone: user?.phone ?? '' });
  const [dst, setDst] = useState({ country: '', operatorId: '', phone: '', name: '' });
  const [bank, setBank] = useState({ bankName: '', accountName: '', accountNumber: '' });
  const [agent, setAgent] = useState('');
  const [card, setCard] = useState({ number: '', expMonth: '', expYear: '', cvc: '', holderName: user?.fullName ?? '' });
  const [preview, setPreview] = useState<any>(null);
  const [route, setRoute] = useState<any>(null);
  const [pin, setPin] = useState(false);
  const [pinFor, setPinFor] = useState<'send' | 'cancel'>('send');
  const [loading, setLoading] = useState(false);
  const history = useAsync(() => api.get<{ items: any[] }>('/api/money'), [route?.status]);
  const destination = () =>
    dest === 'wallet'
      ? { method: 'wallet', to }
      : dest === 'qr'
        ? { method: 'qr', data: qr }
        : dest === 'mobile_money'
          ? { method: 'mobile_money', operatorId: dst.operatorId, phone: dst.phone, name: dst.name || null }
          : dest === 'bank'
            ? { method: 'bank', ...bank }
            : { method: 'agent', agent };
  const ready =
    dest === 'wallet'
      ? to.length >= 3
      : dest === 'qr'
        ? qr.length > 3
        : dest === 'mobile_money'
          ? !!dst.operatorId && dst.phone.length > 5
          : dest === 'bank'
            ? !!bank.bankName && !!bank.accountNumber
            : agent.length >= 2;
  useEffect(() => {
    if (!amount || !ready) return setPreview(null);
    const id = setTimeout(
      () =>
        api
          .post<any>('/api/money/preview', { destination: destination(), sourceMethod: source, amount, currency: cur, targetCurrency: target || cur })
          .then(setPreview)
          .catch(() => setPreview(null)),
      400,
    );
    return () => clearTimeout(id);
  }, [amount, cur, target, source, dest, to, qr, dst, bank, agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!route || ['SETTLED', 'EXPIRED', 'FAILED', 'REVERSED', 'REFUNDED'].includes(route.stage)) return;
    const id = setInterval(
      () =>
        api.get<{ route: any }>(`/api/money/${route.id}`).then((r) => {
          if (r.route.stage !== route.stage || r.route.payment?.stage !== route.payment?.stage || r.route.payout?.stage !== route.payout?.stage) setRoute(r.route);
          if (['SETTLED', 'EXPIRED', 'FAILED', 'REVERSED', 'REFUNDED'].includes(r.route.stage)) refreshWallets();
        }),
      8000,
    );
    return () => clearInterval(id);
  }, [route]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (p?: string) => {
    setLoading(true);
    try {
      const s: any = { method: source };
      if (source === 'card')
        s.card = {
          number: card.number.replace(/\s/g, ''),
          expMonth: Number(card.expMonth),
          expYear: Number(card.expYear.length === 2 ? '20' + card.expYear : card.expYear),
          cvc: card.cvc,
          holderName: card.holderName,
        };
      if (source === 'mobile_money') {
        s.operatorId = src.operatorId || null;
        s.phone = src.phone;
      }
      const r = await api.post<{ route: any }>('/api/money', {
        source: s,
        destination: destination(),
        amount,
        currency: cur,
        targetCurrency: target || null,
        pin: p || undefined,
        quoteId: preview?.fx?.quoteId ?? null,
      });
      setRoute(r.route);
      setPin(false);
      refreshWallets();
      if (r.route.status === 'completed') toast(tr('Money delivered'), 'success');
      else if (r.route.payment?.next?.type === 'redirect' && r.route.payment.next.url) Linking.openURL(r.route.payment.next.url);
    } catch (err) {
      toast((err as Error).message, 'error');
      setPin(false);
    } finally {
      setLoading(false);
    }
  };
  const S: Record<Source, string> = { wallet: '👛 Wallet', card: '💳 Card', mobile_money: '📱 Mobile money', bank: '🏦 Bank' };
  const D: Record<Dest, string> = { wallet: '👛 User', qr: '🔳 QR / link', mobile_money: '📱 Mobile money', bank: '🏦 Bank', agent: '💵 Agent cash' };
  return (
    <Screen>
      <Header title={t('nav.move')} />
      <T muted size={13}>
        {tr(
          'Fund from a card, bank, mobile money or your wallet; deliver to a wallet, QR code, bank, mobile money number or agent. External legs move through your own bank, operator or a licensed processor and are credited only after independent confirmation.',
        )}
      </T>
      {route ? (
        <Card style={{ alignItems: 'center' }}>
          <T size={44}>{route.status === 'completed' ? '✅' : route.status === 'failed' ? '❌' : '⏳'}</T>
          <T bold size={22}>
            {money(route.amount, route.currency)} → {D[route.destination as Dest]}
          </T>
          <Status status={route.stageLabel ?? route.status} />
          {route.error && !['SETTLED'].includes(route.stage) && <Alert kind="error" text={route.error} />}
          {['FUNDED', 'PAYOUT_ROUTED', 'INSUFFICIENT_LIQUIDITY', 'MANUAL_REVIEW', 'FAILED', 'EXPIRED'].includes(route.stage) && (
            <Button
              title={tr('Cancel & refund')}
              variant="ghost"
              onPress={() => {
                setPinFor('cancel');
                setPin(true);
              }}
            />
          )}
          <StageBar stage={route.stage} label={route.stageLabel} description={route.stageDescription} steps={ROUTE_STEPS} />
          {route.stage === 'AWAITING_CONFIRMATION' && route.consent && (
            <>
              <Alert kind="warning" text={`The recipient must confirm receiving ${route.targetCurrency} before the payout is executed. Share the confirmation link.`} />
              <Button
                title={tr('Share confirmation link')}
                variant="secondary"
                onPress={() => Share.share({ message: `Please confirm the currency for the money I am sending you: ${route.consent.url}` })}
              />
            </>
          )}
          {route.confirmationMethod && (
            <T size={11} muted center>
              {tr('Settled on {0}', { 0: String(route.confirmationMethod).replace(/_/g, ' ').toLowerCase() })}
            </T>
          )}
          {route.corridor && (
            <Chip
              label={route.corridor.status === 'live' ? `authorised corridor · ${route.corridor.destCountry}` : `sandbox corridor · ${route.corridor.destCountry} · no real funds`}
              kind={route.corridor.status === 'live' ? 'success' : undefined}
            />
          )}
          {route.payout && (
            <Card soft>
              <T size={12}>
                <T bold>{tr('Local payout')}</T> · {route.payout.operatorName ?? route.payout.rail} · {route.payout.recipientMasked}
              </T>
              <T size={12}>
                {tr('Ref')} {route.payout.reference}
                {route.payout.externalRef ? ` · operator ${route.payout.externalRef}` : ''}
              </T>
            </Card>
          )}
          {['FUNDING_PENDING', 'BIOMETRIC_APPROVAL_REQUIRED'].includes(route.stage) && route.payment?.stage && (
            <StageBar stage={route.payment.stage} label={route.payment.stageLabel} description={route.payment.stageDescription} />
          )}
          {route.status === 'funding' && route.payment?.next?.type === 'bank_instructions' && ['INSTRUCTION_ISSUED', 'PAYMENT_SENT'].includes(route.payment.stage) && (
            <View style={{ alignSelf: 'stretch' }}>
              <Alert text={route.payment.next.message} />
              {Object.entries(route.payment.next.instructions ?? {}).map(([k, v]) => (
                <KV key={k} k={k} v={String(v)} />
              ))}
            </View>
          )}
          {route.status === 'funding' && route.payment?.next?.type === 'prompt' && <Alert text={route.payment.next.message} />}
          {route.status === 'pending' && <Alert text={tr('Money arrived and is held in escrow; the payout is executed by our treasury team or a local agent under maker-checker approval.')} />}
          {route.destinationDetails?.cashOutCode && <Alert kind="success" text={`Cash-out code for the agent: ${route.destinationDetails.cashOutCode}`} />}
          <Button title={tr('New transfer')} variant="secondary" onPress={() => setRoute(null)} />
        </Card>
      ) : (
        <Card>
          <T bold>From</T>
          <Tabs tabs={(Object.keys(S) as Source[]).map((k) => ({ id: k, label: S[k] }))} value={source} onChange={(v) => setSource(v as Source)} />
          {source === 'card' && (
            <>
              <Input label={tr('Card number')} value={card.number} onChangeText={(v) => setCard({ ...card, number: v })} keyboardType="number-pad" />
              <Row>
                <View style={{ flex: 1 }}>
                  <Input label="MM" value={card.expMonth} onChangeText={(v) => setCard({ ...card, expMonth: v })} keyboardType="number-pad" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="YY" value={card.expYear} onChangeText={(v) => setCard({ ...card, expYear: v })} keyboardType="number-pad" />
                </View>
                <View style={{ flex: 1 }}>
                  <Input label="CVC" value={card.cvc} onChangeText={(v) => setCard({ ...card, cvc: v })} keyboardType="number-pad" secureTextEntry />
                </View>
              </Row>
            </>
          )}
          {source === 'mobile_money' && (
            <>
              <OperatorPicker country={src.country} onCountry={(c) => setSrc({ ...src, country: c })} value={src.operatorId} onChange={(id) => setSrc({ ...src, operatorId: id })} />
              <Input label={tr('Your mobile money number')} value={src.phone} onChangeText={(v) => setSrc({ ...src, phone: v })} keyboardType="phone-pad" />
            </>
          )}
          <AmountInput label={t('common.amount')} amount={amount} currency={cur} onAmount={setAmount} onCurrency={setCur} currencies={(config?.currencies ?? []).map((c: any) => c.code)} />
          <T bold>To</T>
          <Tabs tabs={(Object.keys(D) as Dest[]).map((k) => ({ id: k, label: D[k] }))} value={dest} onChange={(v) => setDest(v as Dest)} />
          {dest === 'wallet' && <Input label={tr('Recipient (@tag, email or phone)')} value={to} onChangeText={setTo} autoCapitalize="none" />}
          {dest === 'qr' && <Input label={tr('Payment link or QR content')} value={qr} onChangeText={setQr} autoCapitalize="none" />}
          {dest === 'mobile_money' && (
            <>
              <OperatorPicker country={dst.country} onCountry={(c) => setDst({ ...dst, country: c })} value={dst.operatorId} onChange={(id) => setDst({ ...dst, operatorId: id })} />
              <Input label={tr('Recipient number')} value={dst.phone} onChangeText={(v) => setDst({ ...dst, phone: v })} keyboardType="phone-pad" />
              <Input label={tr('Recipient name')} value={dst.name} onChangeText={(v) => setDst({ ...dst, name: v })} />
            </>
          )}
          {dest === 'bank' && (
            <>
              <Input label={tr('Bank name')} value={bank.bankName} onChangeText={(v) => setBank({ ...bank, bankName: v })} />
              <Input label={tr('Account holder')} value={bank.accountName} onChangeText={(v) => setBank({ ...bank, accountName: v })} />
              <Input label={tr('Account number / IBAN')} value={bank.accountNumber} onChangeText={(v) => setBank({ ...bank, accountNumber: v })} />
            </>
          )}
          {dest === 'agent' && <Input label={tr('Agent @tag')} value={agent} onChangeText={setAgent} autoCapitalize="none" />}
          {preview?.quote?.receivingCurrencies ? (
            <View>
              <T size={12} muted>
                {tr('Recipient receives in (default: local currency {0})', { 0: preview.quote.receivingCurrencies.defaultCurrency })}
              </T>
              <Row style={{ flexWrap: 'wrap' }}>
                {preview.quote.receivingCurrencies.options.map((o: any) => (
                  <Chip
                    key={o.currency}
                    label={`${o.currency}${o.isLocal ? ' · local' : ''}${o.consentRequired ? ' · recipient confirms' : ''}${o.available ? '' : ' · unavailable'}`}
                    kind={o.available ? ((target || preview.quote.targetCurrency) === o.currency ? 'primary' : undefined) : 'danger'}
                    selected={(target || preview.quote.targetCurrency) === o.currency}
                    onPress={o.available ? () => setTarget(o.currency) : undefined}
                  />
                ))}
              </Row>
              {preview.quote.receivingCurrencies.options
                .filter((o: any) => !o.available)
                .map((o: any) => (
                  <T key={o.currency} size={11} muted>
                    {o.currency}: {o.reasons.join('; ')}
                  </T>
                ))}
            </View>
          ) : (
            <Select
              label="Deliver in"
              value={target}
              onChange={setTarget}
              options={[{ value: '', label: `Same as sent (${cur})` }, ...(config?.currencies ?? []).map((c: any) => ({ value: c.code, label: c.code }))]}
            />
          )}
          {preview && (
            <Card soft>
              <Row>
                {preview.destination.user && <Avatar user={preview.destination.user} size={30} />}
                <T bold>{preview.destination.label}</T>
              </Row>
              {preview.quote.rate !== 1 && <KV k={tr('Rate')} v={`${preview.quote.rate.toFixed(4)} · ${preview.fx?.guaranteed ? 'guaranteed' : 'indicative'}`} />}
              {preview.fx && preview.fx.sourceCurrency !== preview.fx.targetCurrency && (
                <T size={11} muted>
                  {tr('Reference {0} · {1} · markup {2}%', { 0: preview.fx.midRate.toFixed(4), 1: preview.fx.providerLabel, 2: (preview.fx.markupBps / 100).toFixed(2) })}
                </T>
              )}
              <KV k={tr('Recipient gets')} v={money(preview.quote.targetAmount, preview.quote.targetCurrency)} />
              <KV k={tr('Guaranteed')} v={preview.quote.guaranteedRecipientAmount != null ? money(preview.quote.guaranteedRecipientAmount, preview.quote.targetCurrency) : 'indicative only'} />
              <KV k={tr('Estimated payout')} v={preview.quote.estimatedPayoutTime} />
              {preview.quote.confirmation && (
                <T size={11} muted>
                  {tr('Confirmed by: funding {0} · payout {1}', {
                    0: preview.quote.confirmation.funding.replace(/_/g, ' ').toLowerCase(),
                    1: preview.quote.confirmation.payout.replace(/_/g, ' ').toLowerCase(),
                  })}
                </T>
              )}
              {preview.quote.recipientConsentRequired && <Alert kind="warning" text={`The recipient must confirm receiving ${preview.quote.targetCurrency} before the payout is executed.`} />}
              {preview.quote.corridor && (
                <T size={11} muted>
                  {preview.quote.corridor.status === 'live' ? tr('Authorised corridor') : tr('Sandbox corridor – no real funds')} · {preview.quote.corridor.destCountry}
                </T>
              )}
              <T size={11} muted>
                {tr('Refunds: {0}', { 0: preview.quote.refundConditions })}
              </T>
              {preview.declaration && (
                <T size={11} muted>
                  {preview.declaration.processing} · {preview.declaration.expectedCompletion} · {preview.declaration.funding.confirmation}
                </T>
              )}
            </Card>
          )}
          <Button
            title={tr('🔐 Confirm and send')}
            loading={loading}
            disabled={!preview}
            onPress={() => {
              setPinFor('send');
              setPin(true);
            }}
          />
        </Card>
      )}
      {(history.data?.items ?? []).length > 0 && (
        <Card>
          <T bold>{tr('Recent')}</T>
          {history.data!.items.slice(0, 8).map((r) => (
            <Row key={r.id} between>
              <View>
                <T bold>{money(r.amount, r.currency)}</T>
                <T muted size={12}>
                  {S[r.source as Source]} → {D[r.destination as Dest]}
                </T>
              </View>
              <Status status={r.status} />
            </Row>
          ))}
        </Card>
      )}
      {history.data?.items.length === 0 && <Empty icon="🔀" />}
      <PinSheet
        open={pin}
        onClose={() => setPin(false)}
        onSubmit={(p) =>
          pinFor === 'cancel' && route
            ? api
                .post<{ route: any }>(`/api/money/${route.id}/cancel`, { pin: p || undefined })
                .then((r) => {
                  setPin(false);
                  setRoute(r.route);
                  refreshWallets();
                  toast(tr('Transfer cancelled'), 'success');
                })
                .catch((e) => {
                  setPin(false);
                  toast(e.message, 'error');
                })
            : submit(p)
        }
        loading={loading}
        title={pinFor === 'cancel' ? tr('Confirm cancellation') : undefined}
        summary={
          pinFor === 'cancel' && route ? (
            <KV k={tr('Cancel transfer')} v={money(route.amount, route.currency)} />
          ) : (
            preview && <KV k={`Send to ${preview.destination.label}`} v={money(preview.quote.targetAmount, preview.quote.targetCurrency)} />
          )
        }
      />
    </Screen>
  );
}
