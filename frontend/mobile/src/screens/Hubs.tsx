import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useStore } from '../lib/store';
import { Screen, Card, T, Row, useTheme, KV, Button, Chip } from '../components/ui';
import { Header } from '../components/Header';
import { useNav } from '../navigation';
import { convertMinor } from '@bitripay/shared';

/**
 * The two hub tabs of the phone app: Pay (every way to pay someone) and Wallet (every balance and every way to fund,
 * withdraw or convert it). Each hub is a set of shortcuts to the existing screens; nothing here moves money itself.
 */
function Tile({ ico, label, hint, onPress }: { ico: string; label: string; hint?: string; onPress: () => void }) {
  const th = useTheme();
  return (
    <Pressable onPress={onPress} style={{ width: '47%', backgroundColor: th.card, borderWidth: 1, borderColor: th.border, borderRadius: 16, padding: 14, gap: 4 }}>
      <Text style={{ fontSize: 24 }}>{ico}</Text>
      <T bold>{label}</T>
      {hint ? (
        <T muted size={12}>
          {hint}
        </T>
      ) : null}
    </Pressable>
  );
}

export function PayHub() {
  const { t, config, user } = useStore();
  const nav = useNav();
  const m = config?.modules ?? {};
  const isMerchant = user?.role === 'merchant';
  return (
    <Screen>
      <Header title="Pay" />
      <T muted>Scan a code, pay a link, send to a person or pay a bill. Every payment is confirmed by the ledger, never by a screen.</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Tile ico="📷" label={t('nav.scan')} hint="Any BitriPay or EMVCo code" onPress={() => nav.navigate('QrLink')} />
        <Tile ico="📤" label={t('nav.send')} hint="@tag, phone or email" onPress={() => nav.navigate('Send')} />
        {m.transfers !== false && <Tile ico="🔀" label={t('nav.move')} hint="Any source to any destination" onPress={() => nav.navigate('Move')} />}
        {m.moneyRequests !== false && <Tile ico="🔗" label={t('nav.requests')} hint="Pay or create a request" onPress={() => nav.navigate('Requests')} />}
        {m.remittance !== false && <Tile ico="🌍" label={t('nav.remittance')} hint="Send abroad, they receive locally" onPress={() => nav.navigate('Remittance')} />}
        {m.billPay !== false && <Tile ico="🧾" label={t('nav.bills')} onPress={() => nav.navigate('Bills')} />}
        {m.mobileTopup !== false && <Tile ico="📶" label={t('nav.topup')} onPress={() => nav.navigate('Topup')} />}
        {m.qrPayments !== false && <Tile ico="📴" label="Offline payments" hint="Pending confirmation until synced" onPress={() => nav.navigate('Offline')} />}
        {isMerchant && <Tile ico="🏪" label={t('nav.merchant')} hint="Charge a customer" onPress={() => nav.navigate('Merchant')} />}
      </View>
    </Screen>
  );
}

export function WalletHub() {
  const { t, wallets, config, money, currency, refreshWallets } = useStore();
  const nav = useNav();
  const th = useTheme();
  const base = config?.baseCurrency ?? 'USD';
  const total = wallets.reduce((s, w) => s + (config ? convertMinor(w.balance, currency(w.currency), currency(base)) : 0), 0);
  const m = config?.modules ?? {};
  return (
    <Screen>
      <Header title="Wallet" />
      <View style={{ backgroundColor: th.primary, borderRadius: 20, padding: 20, gap: 4 }}>
        <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
          {t('dash.totalBalance')} ({base})
        </Text>
        <Text style={{ color: '#fff', fontSize: 30, fontWeight: '800' }}>{money(total, base)}</Text>
      </View>
      <Card>
        <Row between>
          <T bold>Balances</T>
          <Button title="Refresh" small variant="secondary" onPress={() => void refreshWallets()} />
        </Row>
        {wallets.length === 0 && <T muted>No balance yet. Add money to open your first wallet.</T>}
        {wallets.map((w) => (
          <Row key={w.id} between>
            <Row style={{ gap: 8 }}>
              <T bold>{w.currency}</T>
              {w.frozen ? <Chip label="Frozen" kind="danger" /> : null}
              {(w.promoBalance ?? 0) > 0 ? <Chip label={`promo ${money(w.promoBalance ?? 0, w.currency)}`} /> : null}
            </Row>
            <T bold>{money(w.balance, w.currency)}</T>
          </Row>
        ))}
        <KV k="Wallets" v={String(wallets.length)} />
      </Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {m.addMoney !== false && <Tile ico="➕" label={t('nav.addMoney')} hint="Card, mobile money, bank, agent" onPress={() => nav.navigate('AddMoney')} />}
        {m.withdrawals !== false && <Tile ico="🏦" label={t('nav.withdraw')} onPress={() => nav.navigate('Withdraw')} />}
        {m.exchange !== false && <Tile ico="💱" label={t('nav.exchange')} hint="Disclosed rate and margin" onPress={() => nav.navigate('Exchange')} />}
        {m.agents !== false && <Tile ico="🏪" label={t('nav.agents')} hint="Cash in and out" onPress={() => nav.navigate('Agents')} />}
        <Tile ico="🎯" label={t('nav.savings')} onPress={() => nav.navigate('Savings')} />
        {m.virtualCards !== false && <Tile ico="💳" label={t('nav.cards')} onPress={() => nav.navigate('Cards')} />}
        <Tile ico="📑" label={t('nav.statements')} hint="Bank-grade statements" onPress={() => nav.navigate('Statements')} />
        <Tile ico="📊" label={t('nav.insights')} hint="Every chart family" onPress={() => nav.navigate('Insights')} />
        <Tile ico="📜" label={t('nav.transactions')} onPress={() => nav.navigate('Main')} />
      </View>
    </Screen>
  );
}
