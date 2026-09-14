/**
 * Official sanctions lists: registered at first start, parsed as published (US OFAC CSV, UK OFSI CSV, UN XML, EU
 * semicolon CSV), imported per version, and surfaced on the go-live checklist with a console link. The fetch itself
 * is exercised on the host (daily job); here the parsers run on samples in the published layouts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { setupApp, adminToken } from './helpers';
import {
  ensureOfficialSanctionsSources,
  OFFICIAL_SANCTIONS_SOURCES,
  listSources,
  parseSanctionsFeed,
  parseUkOfsiCsv,
  parseUnConsolidatedXml,
  parseEuFsfCsv,
  importSanctionsRows,
} from '../services/risk/compliance';
import { screenSanctions } from '../services/risk';
import { goLiveChecklist } from '../services/goLive';

let app: ReturnType<typeof setupApp>;
beforeAll(() => {
  app = setupApp();
});

const OFAC = `36,"AEROCARIBBEAN AIRLINES","-0-","CUBA","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"
173,"ANGLO-CARIBBEAN CO., LTD.","-0-","CUBA","-0-","-0-","-0-","-0-","-0-","-0-","-0-","-0-"
306,"BANCO NACIONAL DE CUBA","-0-","CUBA","-0-","-0-","-0-","-0-","-0-","-0-","a.k.a. 'BNC'.","-0-"`;

const UK = `Last Updated,01/09/2026
Name 6,Name 1,Name 2,Name 3,Name 4,Name 5,Title,Name Non-Latin Script,Non-Latin Script Type,Non-Latin Script Language,DOB,Town of Birth,Country of Birth,Nationality,Passport Number,Passport Details,National Identification Number,National Identification Details,Position,Address 1,Address 2,Address 3,Address 4,Address 5,Address 6,Post/Zip Code,Country,Other Information,Group Type,Alias Type,Alias Quality,Regime,Listed On,UK Sanctions List Date Designated,Last Updated,Group ID
"AL-ZAWAHIRI",Aiman,Muhammed,Rabi,,,,,,,19/06/1951,Giza,Egypt,Egypt,,,,,,,,,,,,,,"UN Ref QDi.006",Individual,Primary name,,ISIL (Da'esh) and Al-Qaida,02/10/2001,31/12/2020,01/02/2021,6897
"ABDEL RAHMAN",Aiman,,,,,,,,,,,,,,,,,,,,,,,,,,,Individual,AKA,Good,ISIL (Da'esh) and Al-Qaida,02/10/2001,31/12/2020,01/02/2021,6897
"CENTRAL BANK OF SYRIA",,,,,,,,,,,,,,,,,,,,,,,,,,,,Entity,Primary name,,Syria,17/02/2012,31/12/2020,01/02/2021,12345`;

const UN = `<?xml version="1.0" encoding="utf-8"?>
<CONSOLIDATED_LIST dateGenerated="2026-09-01T02:00:03.123Z">
<INDIVIDUALS><INDIVIDUAL><DATAID>6908555</DATAID><VERSIONNUM>1</VERSIONNUM><FIRST_NAME>RI</FIRST_NAME><SECOND_NAME>WON HO</SECOND_NAME><UN_LIST_TYPE>DPRK</UN_LIST_TYPE><REFERENCE_NUMBER>KPi.033</REFERENCE_NUMBER><INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Ri Won-ho</ALIAS_NAME></INDIVIDUAL_ALIAS></INDIVIDUAL></INDIVIDUALS>
<ENTITIES><ENTITY><DATAID>6908742</DATAID><FIRST_NAME>KOREA KUMSAN TRADING CORPORATION &amp; CO</FIRST_NAME><UN_LIST_TYPE>DPRK</UN_LIST_TYPE><REFERENCE_NUMBER>KPe.045</REFERENCE_NUMBER><ENTITY_ALIAS><QUALITY>Low</QUALITY><ALIAS_NAME>Kumsan Trading</ALIAS_NAME></ENTITY_ALIAS></ENTITY></ENTITIES>
</CONSOLIDATED_LIST>`;

const EU = `fileGenerationDate;Entity_LogicalId;Entity_EU_ReferenceNumber;Entity_UnitedNationId;Entity_DesignationDate;Entity_DesignationDetails;Entity_Remark;Entity_SubjectType;Entity_SubjectType_ClassificationCode;Entity_Regulation_Type;Entity_Regulation_OrganisationType;Entity_Regulation_PublicationDate;Entity_Regulation_EntryIntoForceDate;Entity_Regulation_NumberTitle;Entity_Regulation_Programme;Entity_Regulation_PublicationUrl;NameAlias_LastName;NameAlias_FirstName;NameAlias_MiddleName;NameAlias_WholeName;NameAlias_NameLanguage;NameAlias_Gender;NameAlias_Title;NameAlias_Function;NameAlias_LogicalId;NameAlias_RegulationLanguage;NameAlias_Remark
01/09/2026;13;EU.27.28;;2001-05-28;;;person;P;regulation;council;2001-05-28;2001-05-28;2001/927/CFSP;TERR;http://eur-lex.europa.eu/;Alkifah;Ahmed;;Ahmed Alkifah;;;;;13;en;
01/09/2026;42;EU.11.3;;2011-05-09;;;enterprise;E;regulation;council;2011-05-09;2011-05-09;442/2011;SYR;http://eur-lex.europa.eu/;;;;Commercial Bank of Syria;;;;;42;en;`;

describe('official sanctions lists', () => {
  it('registers the official sources once and leaves administrator changes alone', async () => {
    const first = ensureOfficialSanctionsSources();
    const ids = listSources().map((s) => s.id);
    for (const src of OFFICIAL_SANCTIONS_SOURCES) expect(ids).toContain(src.id);
    expect(ensureOfficialSanctionsSources()).toEqual([]);
    expect(first.length === 0 || first.length === OFFICIAL_SANCTIONS_SOURCES.length).toBe(true);
    const admin = await adminToken(app);
    const edit = await request(app)
      .put('/api/admin/risk/sanctions/sources/uk_ofsi')
      .set(admin.auth)
      .send({ name: 'UK OFSI (mirror)', url: 'https://example.com/ConList.csv', format: 'uk_ofsi', enabled: false });
    expect(edit.status).toBe(200);
    ensureOfficialSanctionsSources();
    const uk = listSources().find((s) => s.id === 'uk_ofsi')!;
    expect(uk.url).toBe('https://example.com/ConList.csv');
    expect(uk.enabled).toBe(false);
    expect(uk.format).toBe('uk_ofsi');
  });

  it('parses the US OFAC, UK OFSI, UN and EU layouts as published', () => {
    const ofac = parseSanctionsFeed('ofac_sdn', OFAC);
    expect(ofac.map((r) => r.value)).toEqual(['AEROCARIBBEAN AIRLINES', 'ANGLO-CARIBBEAN CO., LTD.', 'BANCO NACIONAL DE CUBA']);
    expect(ofac[2].externalId).toBe('306');

    const uk = parseUkOfsiCsv(UK);
    expect(uk).toHaveLength(3);
    expect(uk[0]).toMatchObject({ kind: 'name', value: 'Aiman Muhammed Rabi AL-ZAWAHIRI', externalId: '6897' });
    expect(uk[0].note).toContain("ISIL (Da'esh) and Al-Qaida");
    expect(uk[1].value).toBe('Aiman ABDEL RAHMAN');
    expect(uk[2]).toMatchObject({ value: 'CENTRAL BANK OF SYRIA', externalId: '12345' });

    const un = parseUnConsolidatedXml(UN);
    expect(un.map((r) => r.value)).toEqual(['RI WON HO', 'Ri Won-ho', 'KOREA KUMSAN TRADING CORPORATION & CO', 'Kumsan Trading']);
    expect(un[0]).toMatchObject({ externalId: '6908555', note: 'DPRK · KPi.033' });
    expect(un[2].note).toBe('DPRK · KPe.045 · entity');

    const eu = parseEuFsfCsv(EU);
    expect(eu).toHaveLength(2);
    expect(eu[0]).toMatchObject({ value: 'Ahmed Alkifah', externalId: '13' });
    expect(eu[1]).toMatchObject({ value: 'Commercial Bank of Syria', externalId: '42' });
    expect(eu[1].note).toContain('enterprise');
    expect(parseSanctionsFeed('eu_fsf', 'nothing;here')).toEqual([]);
  });

  it('imports a version per source, screens against it and shows the lists on the checklist with a console link', async () => {
    ensureOfficialSanctionsSources();
    const out = importSanctionsRows('un_consolidated', parseUnConsolidatedXml(UN), 'sample-2026-09-01', { type: 'system' });
    expect(out.imported).toBe(4);
    expect(importSanctionsRows('un_consolidated', parseUnConsolidatedXml(UN), 'sample-2026-09-01', { type: 'system' }).replaced).toBe(4);
    expect(screenSanctions({ name: 'Ri Won Ho' } as any).some((h) => h.startsWith('sanctions:'))).toBe(true);
    expect(screenSanctions({ name: 'Mireille Kabongo' } as any).filter((h) => h.startsWith('sanctions:'))).toEqual([]);
    const item = goLiveChecklist().items.find((i) => i.id === 'sanctions')!;
    expect(item.ok).toBe(true);
    expect(item.detail).toMatch(/UN Security Council consolidated list: 4/);
    expect(item.href).toBe('/risk');
    const admin = await adminToken(app);
    const res = await request(app).get('/api/admin/go-live').set(admin.auth);
    expect(res.body.items.find((i: any) => i.id === 'kyc').href).toBe('/fees');
    expect(res.body.items.find((i: any) => i.id === 'maker_checker').href).toBe('/users?role=admin');
  });
});
