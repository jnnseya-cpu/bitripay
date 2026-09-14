import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, T, Qr, TxRow, Empty, useAsync, useTheme, Avatar, Button, Row, Chip } from '../components/ui';
import { Header } from '../components/Header';
import { useNav } from '../navigation';
import { convertMinor, type Transaction } from '@bitripay/shared';

export function Home() {
  const { user, wallets, config, money, currency, t, unread } = useStore();
  const nav = useNav();
  const th = useTheme();
  const tx = useAsync(() => api.get<{ items: Transaction[] }>('/api/wallets/transactions?pageSize=6'), [wallets]);
  const base = config?.baseCurrency ?? 'USD';
  const total = wallets.reduce((s, w) => s + (config ? convertMinor(w.balance, currency(w.currency), currency(base)) : 0), 0);
  const m = config?.modules ?? {};
  const actions: [string, string, string, string][] = [
    ['Send', '📤', t('nav.send'), 'transfers'],
    ['Move', '🔀', t('nav.move'), 'transfers'],
    ['AddMoney', '➕', t('nav.addMoney'), 'addMoney'],
    ['Requests', '🔗', t('nav.requests'), 'moneyRequests'],
    ['Withdraw', '🏦', t('nav.withdraw'), 'withdrawals'],
    ['Agents', '🏪', t('nav.agents'), 'agents'],
    ['Remittance', '🌍', t('nav.remittance'), 'remittance'],
    ['Exchange', '💱', t('nav.exchange'), 'exchange'],
    ['Savings', '🎯', t('nav.savings'), 'transfers'],
    ['Offline', '📴', 'Offline payments', 'qrPayments'],
    ['Bills', '🧾', t('nav.bills'), 'billPay'],
    ['Topup', '📶', t('nav.topup'), 'mobileTopup'],
    ['Cards', '💳', t('nav.cards'), 'virtualCards'],
    ['GiftCards', '🎁', t('nav.giftCards'), 'giftCards'],
    ['P2P', '🤝', t('nav.p2p'), 'p2p'],
  ];
  return (
    <Screen>
      <Row between>
        <Row>
          <Avatar user={user} />
          <View>
            <T muted size={13}>
              {t('dash.welcome', { name: '' }).replace(', ', '')}
            </T>
            <T bold size={18}>
              {user?.fullName}
            </T>
          </View>
        </Row>
        <Pressable
          onPress={() => nav.navigate('Notifications')}
          style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: th.card, borderWidth: 1, borderColor: th.border, alignItems: 'center', justifyContent: 'center' }}
        >
          <Text>🔔</Text>
          {unread > 0 && (
            <View style={{ position: 'absolute', top: -4, right: -4, backgroundColor: th.danger, borderRadius: 9, minWidth: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>{unread}</Text>
            </View>
          )}
        </Pressable>
      </Row>
      <View style={{ backgroundColor: th.primary, borderRadius: 20, padding: 20, gap: 8 }}>
        <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>
          {t('dash.totalBalance')} ({base})
        </Text>
        <Text style={{ color: '#fff', fontSize: 34, fontWeight: '800' }}>{money(total, base)}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {wallets.map((w) => (
            <View key={w.id} style={{ backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>{money(w.balance, w.currency)}</Text>
            </View>
          ))}
          <Pressable onPress={() => nav.navigate('Exchange')} style={{ backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 12 }}>+ {t('nav.exchange')}</Text>
          </Pressable>
        </ScrollView>
      </View>
      <T bold size={16}>
        {t('dash.quickActions')}
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {actions
          .filter(([, , , mod]) => m[mod] !== false)
          .map(([screen, ico, label]) => (
            <Pressable
              key={screen}
              onPress={() => nav.navigate(screen as any)}
              style={{ width: '22%', flexGrow: 1, alignItems: 'center', gap: 6, backgroundColor: th.card, borderWidth: 1, borderColor: th.border, borderRadius: 14, paddingVertical: 12 }}
            >
              <View style={{ width: 42, height: 42, borderRadius: 12, backgroundColor: th.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 20 }}>{ico}</Text>
              </View>
              <Text numberOfLines={2} style={{ color: th.text, fontSize: 11, fontWeight: '600', textAlign: 'center' }}>
                {label}
              </Text>
            </Pressable>
          ))}
      </View>
      <Button title="🧭 Command centre · ask your agents" variant="secondary" onPress={() => nav.navigate('Assist')} />
      {user?.role === 'merchant' && <Button title="🏪 Merchant tools · POS & gateway" variant="secondary" onPress={() => nav.navigate('Merchant')} />}
      {user?.role === 'agent' && <Button title="🧑‍💼 Agent tools · cash in / out" variant="secondary" onPress={() => nav.navigate('Agent')} />}
      {user?.kycStatus !== 'verified' && m.kyc !== false && (
        <Pressable onPress={() => nav.navigate('Kyc')}>
          <Chip label={user?.kycStatus === 'pending' ? 'KYC under review' : 'Verify your identity to raise limits →'} kind="warning" />
        </Pressable>
      )}
      <Card>
        <Row between>
          <T bold size={16}>
            {t('dash.recent')}
          </T>
          <Pressable onPress={() => nav.navigate('Main' as any)}>
            <T color={th.primary} size={13}>
              {t('dash.viewAll')} →
            </T>
          </Pressable>
        </Row>
        {tx.data?.items.length === 0 && <Empty icon="💸" />}
        {tx.data?.items.map((item) => (
          <TxRow key={item.id} tx={item} onPress={() => nav.navigate('TxDetail', { id: item.id })} />
        ))}
      </Card>
      <Card style={{ alignItems: 'center' }}>
        <Qr value={`${config?.webUrl ?? ''}/q?v=1&t=${user?.role === 'merchant' ? 'm' : user?.role === 'agent' ? 'ag' : 'u'}&id=${user?.tag}`} size={140} />
        <T muted size={12}>
          @{user?.tag} · {t('receive.subtitle')}
        </T>
      </Card>
    </Screen>
  );
}

export function More() {
  const { user, logout, t, config } = useStore();
  const nav = useNav();
  const th = useTheme();
  const m = config?.modules ?? {};
  const items: [string, string, string, string?][] = [
    ['Move', '🔀', t('nav.move'), 'transfers'],
    ['Requests', '🔗', t('nav.requests'), 'moneyRequests'],
    ['Withdraw', '🏦', t('nav.withdraw'), 'withdrawals'],
    ['Agents', '🏪', t('nav.agents'), 'agents'],
    ['Remittance', '🌍', t('nav.remittance'), 'remittance'],
    ['Exchange', '💱', t('nav.exchange'), 'exchange'],
    ['Savings', '🎯', t('nav.savings')],
    ['Offline', '📴', 'Offline payments', 'qrPayments'],
    ['Cards', '💳', t('nav.cards'), 'virtualCards'],
    ['Bills', '🧾', t('nav.bills'), 'billPay'],
    ['Topup', '📶', t('nav.topup'), 'mobileTopup'],
    ['GiftCards', '🎁', t('nav.giftCards'), 'giftCards'],
    ['P2P', '🤝', t('nav.p2p'), 'p2p'],
    ['Referrals', '🎉', t('nav.referrals'), 'referrals'],
    ['Support', '💬', t('nav.support'), 'support'],
    ['Kyc', '🪪', t('settings.kyc'), 'kyc'],
    ['Statements', '🧾', 'Statements'],
    ['Insights', '📊', t('nav.insights')],
    ['Security', '🔐', t('settings.security')],
    ['Settings', '⚙️', t('nav.settings')],
  ];
  if (user?.role === 'merchant') items.unshift(['Merchant', '🏪', t('nav.merchant')], ['MerchantGateway', '🔌', 'Gateway & API keys']);
  if (user?.role === 'agent') items.unshift(['Agent', '🧑‍💼', t('nav.agentTools')]);
  return (
    <Screen title="More">
      <Card>
        <Row>
          <Avatar user={user} size={52} />
          <View>
            <T bold size={18}>
              {user?.businessName || user?.fullName}
            </T>
            <T muted>
              @{user?.tag} · {user?.role}
            </T>
          </View>
        </Row>
      </Card>
      <Card style={{ padding: 6 }}>
        {items
          .filter(([, , , mod]) => !mod || m[mod] !== false)
          .map(([screen, ico, label]) => (
            <Pressable
              key={screen}
              onPress={() => nav.navigate(screen as any)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderBottomWidth: 1, borderColor: th.border }}
            >
              <Text style={{ fontSize: 18, width: 26, textAlign: 'center' }}>{ico}</Text>
              <Text style={{ color: th.text, fontSize: 16, flex: 1 }}>{label}</Text>
              <Text style={{ color: th.muted }}>›</Text>
            </Pressable>
          ))}
      </Card>
      <Button title={t('nav.logout')} variant="secondary" onPress={logout} />
    </Screen>
  );
}

export function Notifications() {
  const { notifications, refreshWallets } = useStore();
  const th = useTheme();
  return (
    <Screen>
      <Header title="Notifications" right={<Button title="Mark all read" small variant="ghost" onPress={() => api.post('/api/account/notifications/read').then(refreshWallets)} />} />
      {notifications.length === 0 && <Empty icon="🔔" />}
      {notifications.map((n) => (
        <Card key={n.id} style={{ opacity: n.read ? 0.65 : 1 }}>
          <T bold>{n.title}</T>
          <T size={14}>{n.body}</T>
          <T muted size={11}>
            {new Date(n.createdAt).toLocaleString()}
          </T>
          <View style={{ height: 0, borderColor: th.border }} />
        </Card>
      ))}
    </Screen>
  );
}
