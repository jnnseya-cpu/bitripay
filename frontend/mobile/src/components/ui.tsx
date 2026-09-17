import React, { useEffect, useRef, useState } from 'react';
import { tr } from '../lib/i18n';
import {
  ActivityIndicator,
  Image,
  Modal as RNModal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import QRCodeSvg from 'react-native-qrcode-svg';
import { useStore } from '../lib/store';
import { light, darkTheme, type Theme } from '../lib/theme';
import type { PublicUser, Transaction } from '@bitripay/shared';
import { TRANSACTION_TYPE_LABELS, currencyLabel } from '@bitripay/shared';

export function useTheme(): Theme {
  const { dark } = useStore();
  return dark ? darkTheme : light;
}

export function Screen({ children, title, scroll = true, padded = true, right }: { children: React.ReactNode; title?: string; scroll?: boolean; padded?: boolean; right?: React.ReactNode }) {
  const th = useTheme();
  const body = (
    <View style={{ padding: padded ? 16 : 0, gap: 12, flex: scroll ? undefined : 1 }}>
      {title && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 26, fontWeight: '800', color: th.text, letterSpacing: -0.5 }}>{title}</Text>
          {right}
        </View>
      )}
      {children}
    </View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: th.bg }} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {scroll ? (
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
            {body}
          </ScrollView>
        ) : (
          body
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Card({ children, style, soft }: { children: React.ReactNode; style?: ViewStyle; soft?: boolean }) {
  const th = useTheme();
  return <View style={[{ backgroundColor: soft ? th.soft : th.card, borderRadius: 16, padding: 16, borderWidth: soft ? 0 : 1, borderColor: th.border, gap: 8 }, style]}>{children}</View>;
}

export function T({
  children,
  muted,
  bold,
  size = 15,
  color,
  center,
  style,
  mono,
}: {
  children: React.ReactNode;
  muted?: boolean;
  bold?: boolean;
  size?: number;
  color?: string;
  center?: boolean;
  style?: any;
  mono?: boolean;
}) {
  const th = useTheme();
  return (
    <Text
      style={[
        {
          color: color ?? (muted ? th.muted : th.text),
          fontSize: size,
          fontWeight: bold ? '700' : '400',
          textAlign: center ? 'center' : 'left',
          fontFamily: mono ? (Platform.OS === 'ios' ? 'Menlo' : 'monospace') : undefined,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function Button({
  title,
  onPress,
  variant,
  loading,
  disabled,
  small,
  icon,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'secondary' | 'ghost' | 'danger' | 'success';
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  icon?: string;
}) {
  const th = useTheme();
  const bg = variant === 'secondary' ? th.card : variant === 'ghost' ? 'transparent' : variant === 'danger' ? th.danger : variant === 'success' ? th.success : th.primary;
  const color = variant === 'secondary' ? th.text : variant === 'ghost' ? th.primary : '#fff';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => ({
        backgroundColor: bg,
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        paddingVertical: small ? 8 : 14,
        paddingHorizontal: small ? 12 : 18,
        borderRadius: 12,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        borderWidth: variant === 'secondary' ? 1 : 0,
        borderColor: th.border,
      })}
    >
      {loading ? <ActivityIndicator color={color} /> : null}
      {icon ? <Text style={{ fontSize: small ? 14 : 16 }}>{icon}</Text> : null}
      <Text style={{ color, fontWeight: '700', fontSize: small ? 14 : 16 }}>{title}</Text>
    </Pressable>
  );
}

export function Input({ label, hint, style, big, ...props }: TextInputProps & { label?: string; hint?: string; big?: boolean }) {
  const th = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label && <Text style={{ color: th.text, fontWeight: '600', fontSize: 13 }}>{label}</Text>}
      <TextInput
        placeholderTextColor={th.muted}
        {...props}
        style={[
          {
            backgroundColor: th.card,
            color: th.text,
            borderWidth: 1,
            borderColor: th.border,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: big ? 14 : 12,
            fontSize: big ? 28 : 16,
            fontWeight: big ? '700' : '400',
          },
          style,
        ]}
      />
      {hint && <Text style={{ color: th.muted, fontSize: 12 }}>{hint}</Text>}
    </View>
  );
}

export function Select({ label, value, options, onChange }: { label?: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const th = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View style={{ gap: 6 }}>
      {label && <Text style={{ color: th.text, fontWeight: '600', fontSize: 13 }}>{label}</Text>}
      <Pressable
        onPress={() => setOpen(true)}
        style={{ backgroundColor: th.card, borderWidth: 1, borderColor: th.border, borderRadius: 12, padding: 12, flexDirection: 'row', justifyContent: 'space-between' }}
      >
        <Text style={{ color: th.text, fontSize: 16 }}>{current?.label ?? value ?? '—'}</Text>
        <Text style={{ color: th.muted }}>▾</Text>
      </Pressable>
      <Sheet open={open} onClose={() => setOpen(false)} title={label}>
        <ScrollView style={{ maxHeight: 380 }}>
          {options.map((o) => (
            <Pressable
              key={o.value}
              onPress={() => {
                onChange(o.value);
                setOpen(false);
              }}
              style={{ padding: 14, borderBottomWidth: 1, borderColor: th.border, backgroundColor: o.value === value ? th.primarySoft : undefined, borderRadius: 8 }}
            >
              <Text style={{ color: th.text, fontSize: 16 }}>{o.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </Sheet>
    </View>
  );
}

export function Chip({ label, kind, onPress, selected }: { label: string; kind?: 'success' | 'warning' | 'danger' | 'primary'; onPress?: () => void; selected?: boolean }) {
  const th = useTheme();
  const map = { success: [th.successSoft, th.success], warning: [th.warningSoft, th.warning], danger: [th.dangerSoft, th.danger], primary: [th.primarySoft, th.primary] } as const;
  const [bg, fg] = selected ? [th.primary, '#fff'] : kind ? map[kind] : [th.soft, th.muted];
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={{ backgroundColor: bg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}>
      <Text style={{ color: fg, fontWeight: '600', fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}
const STATUS_KIND: Record<string, 'success' | 'warning' | 'danger' | 'primary' | undefined> = {
  completed: 'success',
  paid: 'success',
  succeeded: 'success',
  verified: 'success',
  active: 'success',
  open: 'primary',
  pending: 'warning',
  escrowed: 'warning',
  ready_for_pickup: 'warning',
  negotiating: 'primary',
  failed: 'danger',
  rejected: 'danger',
  declined: 'danger',
  disputed: 'danger',
  reversed: 'danger',
  frozen: 'warning',
};
export const Status = ({ status }: { status: string }) => <Chip label={status.replace(/_/g, ' ')} kind={STATUS_KIND[status]} />;

export function Avatar({ user, size = 40 }: { user?: PublicUser | null; size?: number }) {
  const initials = (user?.businessName || user?.fullName || '?')
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  if (user?.pictureUrl) return <Image source={{ uri: user.pictureUrl }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#e2e8f0' }} />;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: user?.avatarColor || '#64748b', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>{initials}</Text>
    </View>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: React.ReactNode }) {
  const th = useTheme();
  return (
    <RNModal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(15,23,42,0.5)' }} onPress={onClose} />
      <View style={{ backgroundColor: th.card, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 34, gap: 12, maxHeight: '88%' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: th.text, fontSize: 18, fontWeight: '700' }}>{title}</Text>
          <Pressable onPress={onClose}>
            <Text style={{ color: th.muted, fontSize: 18 }}>✕</Text>
          </Pressable>
        </View>
        {children}
      </View>
    </RNModal>
  );
}

/** PIN prompt used before every money movement. */
export function PinSheet({
  open,
  onClose,
  onSubmit,
  summary,
  loading,
  title,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (pin: string) => void;
  summary?: React.ReactNode;
  loading?: boolean;
  title?: string;
}) {
  const { t, user, biometrics, biometricPin } = useStore();
  const [pin, setPin] = useState('');
  const [bioTried, setBioTried] = useState(false);
  useEffect(() => {
    if (open) {
      setPin('');
      setBioTried(false);
    }
  }, [open]);
  // Offer biometrics automatically when the sheet opens.
  useEffect(() => {
    if (!open || !biometrics || bioTried) return;
    setBioTried(true);
    biometricPin().then((p) => {
      if (p) onSubmit(p);
    });
  }, [open, biometrics, bioTried, biometricPin, onSubmit]);
  return (
    <Sheet open={open} onClose={onClose} title={title ?? t('common.confirm')}>
      {summary}
      {biometrics && user?.hasPin && (
        <Button
          title={tr('🔐 Confirm with biometrics')}
          variant="secondary"
          onPress={() =>
            biometricPin().then((p) => {
              if (p) onSubmit(p);
            })
          }
        />
      )}
      {!user?.hasPin ? (
        <Alert kind="warning" text={tr('Set a transaction PIN in Settings → Security first.')} />
      ) : (
        <>
          <Input
            label={t('common.pin')}
            value={pin}
            onChangeText={(v) => setPin(v.replace(/\D/g, ''))}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            autoFocus
            style={{ textAlign: 'center', letterSpacing: 12, fontSize: 24 }}
          />
          <Button title={t('common.confirm')} loading={loading} disabled={pin.length < 4} onPress={() => onSubmit(pin)} />
        </>
      )}
    </Sheet>
  );
}

export function Alert({ kind = 'info', text }: { kind?: 'info' | 'error' | 'success' | 'warning'; text: string }) {
  const th = useTheme();
  const map = { info: [th.primarySoft, th.primary], error: [th.dangerSoft, th.danger], success: [th.successSoft, th.success], warning: [th.warningSoft, th.warning] } as const;
  const [bg, fg] = map[kind];
  return (
    <View style={{ backgroundColor: bg, padding: 12, borderRadius: 12 }}>
      <Text style={{ color: fg, fontSize: 14 }}>{text}</Text>
    </View>
  );
}

export function KV({ k, v }: { k: string; v: React.ReactNode }) {
  const th = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: th.border, gap: 12 }}>
      <Text style={{ color: th.muted }}>{k}</Text>
      {typeof v === 'string' || typeof v === 'number' ? <Text style={{ color: th.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' }}>{v}</Text> : v}
    </View>
  );
}

export function Qr({ value, size = 220 }: { value: string; size?: number }) {
  return (
    <View style={{ backgroundColor: '#fff', padding: 14, borderRadius: 16, alignSelf: 'center' }}>
      <QRCodeSvg value={value} size={size} color="#0f172a" />
    </View>
  );
}

export function Loading() {
  const th = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <ActivityIndicator color={th.primary} size="large" />
    </View>
  );
}

export function Empty({ icon = '🗂️', text }: { icon?: string; text?: string }) {
  const { t } = useStore();
  return (
    <View style={{ alignItems: 'center', padding: 28, gap: 6 }}>
      <Text style={{ fontSize: 34 }}>{icon}</Text>
      <T muted>{text ?? t('common.none')}</T>
    </View>
  );
}

export function Row({ children, style, between }: { children: React.ReactNode; style?: ViewStyle; between?: boolean }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: between ? 'space-between' : 'flex-start' }, style]}>{children}</View>;
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  const th = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
      {tabs.map((tab) => (
        <Pressable key={tab.id} onPress={() => onChange(tab.id)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: value === tab.id ? th.primary : th.soft }}>
          <Text style={{ color: value === tab.id ? '#fff' : th.muted, fontWeight: '600' }}>{tab.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const TX_ICONS: Record<string, string> = {
  transfer: '↔️',
  qr_payment: '📷',
  merchant_payment: '🏪',
  money_request: '🙋',
  card_deposit: '💳',
  bank_deposit: '🏦',
  mobile_money_deposit: '📱',
  agent_cash_in: '💵',
  agent_cash_out: '🏧',
  withdrawal: '🏦',
  remittance: '🌍',
  exchange: '💱',
  virtual_card_funding: '💳',
  gift_card: '🎁',
  bill_payment: '🧾',
  mobile_topup: '📶',
  referral_reward: '🎉',
  admin_adjustment: '🛠️',
  refund: '↩️',
};

export function TxRow({ tx, onPress }: { tx: Transaction; onPress?: () => void }) {
  const th = useTheme();
  const { money } = useStore();
  const isIn = tx.direction === 'in';
  const who = tx.counterparty ? tx.counterparty.businessName || tx.counterparty.fullName : tr(TRANSACTION_TYPE_LABELS[tx.type]);
  const shown = isIn ? (tx.receiveAmount ?? tx.amount) : tx.amount + (tx.direction === 'out' && (tx.metadata as any)?.feeFrom !== 'receiver' ? tx.fee : 0);
  return (
    <Pressable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: th.border }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: th.soft, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 18 }}>{TX_ICONS[tx.type] ?? '•'}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: th.text, fontWeight: '600' }}>
          {who}
        </Text>
        <Text numberOfLines={1} style={{ color: th.muted, fontSize: 12 }}>
          {tr(TRANSACTION_TYPE_LABELS[tx.type])} · {new Date(tx.createdAt).toLocaleDateString()}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text style={{ color: isIn ? th.success : th.text, fontWeight: '700' }}>
          {isIn ? '+' : tx.direction === 'out' ? '-' : ''}
          {money(shown, isIn ? (tx.receiveCurrency ?? tx.currency) : tx.currency)}
        </Text>
        <Status status={tx.status} />
      </View>
    </Pressable>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const ref = useRef(fn);
  ref.current = fn;
  const run = () => {
    setLoading(true);
    return ref
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload: run, setData };
}

export function Toasts() {
  const { toasts } = useStore();
  const th = useTheme();
  if (!toasts.length) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', bottom: 90, left: 16, right: 16, gap: 8 }}>
      {toasts.map((x) => (
        <View key={x.id} style={{ backgroundColor: x.kind === 'error' ? th.danger : x.kind === 'success' ? th.success : th.text, padding: 12, borderRadius: 12 }}>
          <Text style={{ color: '#fff', fontWeight: '600' }}>{x.message}</Text>
        </View>
      ))}
    </View>
  );
}

export function AmountInput({
  amount,
  currency,
  onAmount,
  onCurrency,
  currencies,
  label,
}: {
  amount: string;
  currency: string;
  onAmount: (v: string) => void;
  onCurrency: (c: string) => void;
  currencies?: string[];
  label?: string;
}) {
  const { wallets, config } = useStore();
  const th = useTheme();
  const codes = currencies ?? (wallets.length ? wallets.map((w) => w.currency) : (config?.currencies ?? []).map((c: any) => c.code));
  return (
    <View style={{ gap: 6 }}>
      {label && <Text style={{ color: th.text, fontWeight: '600', fontSize: 13 }}>{label}</Text>}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput
          value={amount}
          onChangeText={(v) => onAmount(v.replace(/[^\d.]/g, ''))}
          keyboardType="decimal-pad"
          placeholder="0.00"
          placeholderTextColor={th.muted}
          style={{
            flex: 1,
            backgroundColor: th.card,
            color: th.text,
            borderWidth: 1,
            borderColor: th.border,
            borderRadius: 12,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 28,
            fontWeight: '700',
          }}
        />
        <View style={{ width: 110 }}>
          <Select value={currency} onChange={onCurrency} options={codes.map((c: string) => ({ value: c, label: currencyLabel(c) }))} />
        </View>
      </View>
    </View>
  );
}
