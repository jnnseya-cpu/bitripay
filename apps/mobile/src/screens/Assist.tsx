import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Screen, Card, Button, Input, Alert, T, Row, Chip, useTheme, Empty } from '../components/ui';
import { useNav } from '../navigation';

/**
 * Command centre on the phone: pick an agent, ask in plain words, watch each check it makes, and confirm any prepared
 * action yourself. Agents never move money. Runs are polled until they finish (streaming is used on the web).
 */
interface AgentCard { key: string; name: string; icon: string; tagline: string; suggestions: string[]; enabled: boolean; paused: boolean }
interface Run { id: string; agent: string; agentName: string; status: string; input: string; output: string | null; actions: { id: string; tool: string; outcome: string }[]; proposals: any[]; createdAt: string; error: string | null }

const SCREEN_FOR: Record<string, string> = { '/app/send': 'Send', '/app/move': 'Move', '/app/add-money': 'AddMoney', '/app/withdraw': 'Withdraw', '/app/exchange': 'Exchange', '/app/requests': 'Requests', '/app/statements': 'Statements', '/app/topup': 'Topup', '/app/bills': 'Bills', '/app/settings?tab=kyc': 'Kyc', '/app/settings?tab=security': 'Security' };
const label = (tool: string) => tool.replace(/^admin\./, 'admin: ').replace(/[._]/g, ' ');

export function Assist() {
  const { user } = useStore();
  const nav = useNav();
  const th = useTheme();
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [mode, setMode] = useState<'offline' | 'live'>('offline');
  const [usage, setUsage] = useState<any>(null);
  const [agent, setAgent] = useState<AgentCard | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    api.get<{ agents: AgentCard[]; runtime: any; usage: any }>('/api/assist/agents').then((r) => { setAgents(r.agents); setMode(r.runtime.mode); setUsage(r.usage); setAgent((a) => a ?? r.agents[0] ?? null); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!agent) return;
    api.get<{ items: Run[] }>(`/api/assist/runs?agent=${agent.key}&limit=8`).then((r) => setRuns(r.items.reverse())).catch(() => setRuns([]));
  }, [agent?.key]);
  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50); }, [runs.length, busy?.actions.length]);

  const ask = async (text: string) => {
    if (!agent || !text.trim() || busy) return;
    setInput('');
    setError(null);
    try {
      const r = await api.post<{ run: Run }>('/api/assist/runs', { agent: agent.key, input: text });
      let run = r.run;
      setBusy(run);
      while (['queued', 'running'].includes(run.status)) {
        await new Promise<void>((res) => setTimeout(() => res(), 900));
        run = (await api.get<{ run: Run }>(`/api/assist/runs/${run.id}`)).run;
        setBusy(run);
      }
      setRuns((rs) => [...rs, run]);
      setBusy(null);
      api.get<{ usage: any }>('/api/assist/usage').then((u) => setUsage(u.usage)).catch(() => {});
    } catch (e: any) {
      setBusy(null);
      setError(e.message);
    }
  };
  const open = (link: string) => {
    const [path, query] = link.split('?');
    const screen = SCREEN_FOR[link] ?? SCREEN_FOR[path];
    if (!screen) return;
    const params: Record<string, string> = {};
    for (const kv of (query ?? '').split('&').filter(Boolean)) {
      const [k, v] = kv.split('=');
      params[decodeURIComponent(k)] = decodeURIComponent(v ?? '');
    }
    nav.navigate(screen as any, Object.keys(params).length ? params : undefined);
  };

  return (
    <Screen title="Command centre" scroll={false}>
      <View style={{ flex: 1, gap: 10 }}>
        {mode === 'offline' && <Alert kind="info" text="Agents answer from built-in checks right now; every question still goes through the same audited tools." />}
        {error && <Alert kind="error" text={error} />}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {agents.map((a) => <Chip key={a.key} label={`${a.icon} ${a.name}${a.paused ? ' (paused)' : !a.enabled ? ' (off)' : ''}`} selected={agent?.key === a.key} onPress={() => setAgent(a)} />)}
        </ScrollView>
        {agent && <T muted size={12}>{agent.tagline}{usage && !usage.unlimited ? ` · ${usage.acuUsed}/${usage.allowance} credits used this month` : ''}</T>}
        <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ gap: 10, paddingBottom: 8 }}>
          {runs.length === 0 && !busy && <Empty icon={agent?.icon ?? '🧭'} text={`Ask ${agent?.name ?? 'an agent'} about your account. It reads your data, explains it and prepares actions you confirm yourself.`} />}
          {[...runs, ...(busy ? [busy] : [])].map((r) => (
            <View key={r.id} style={{ gap: 6 }}>
              <View style={{ alignSelf: 'flex-end', backgroundColor: th.primary, borderRadius: 14, padding: 10, maxWidth: '85%' }}><T color="#fff">{r.input}</T></View>
              {r.actions.length > 0 && <Row style={{ flexWrap: 'wrap', gap: 6 }}>{r.actions.map((a) => <Chip key={a.id} label={`${a.outcome === 'executed' ? '✓' : a.outcome === 'denied' ? '⛔' : a.outcome === 'awaiting_approval' ? '⏳' : '!'} ${label(a.tool)}`} kind={a.outcome === 'executed' ? 'success' : a.outcome === 'denied' ? 'danger' : 'warning'} />)}</Row>}
              {r.output ? <View style={{ alignSelf: 'flex-start', backgroundColor: th.card, borderWidth: 1, borderColor: th.border, borderRadius: 14, padding: 10, maxWidth: '92%' }}><T size={14}>{r.output}</T></View> : ['queued', 'running'].includes(r.status) ? <T muted size={12}>Checking…</T> : null}
              {r.status === 'failed' && <Alert kind="error" text={r.error ?? 'Something went wrong.'} />}
              {r.status === 'budget_exhausted' && <Alert kind="warning" text="Your monthly agent credit is used up. It resets next month." />}
              {r.status === 'awaiting_approval' && <Alert kind="warning" text="Queued for a second administrator to approve." />}
              {r.proposals.map((p, i) => (
                <Pressable key={i} onPress={() => open(p.link)} style={{ borderWidth: 1, borderStyle: 'dashed', borderColor: th.primary, borderRadius: 12, padding: 10, gap: 4, alignSelf: 'flex-start', maxWidth: '92%' }}>
                  <T bold>{p.title}</T><T muted size={12}>{p.why ?? 'Prepared for you to confirm. Nothing has been executed.'}</T><T color={th.primary} size={13}>Review & confirm →</T>
                </Pressable>
              ))}
            </View>
          ))}
        </ScrollView>
        {agent && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{agent.suggestions.map((s) => <Chip key={s} label={s} onPress={() => ask(s)} />)}</ScrollView>}
        <Row>
          <View style={{ flex: 1 }}><Input value={input} onChangeText={setInput} placeholder={agent ? `Ask ${agent.name}…` : 'Ask…'} editable={!busy && !!agent && agent.enabled && !agent.paused} onSubmitEditing={() => ask(input)} returnKeyType="send" /></View>
          <Button title="Ask" onPress={() => ask(input)} disabled={!input.trim() || !!busy || !agent} loading={!!busy} />
        </Row>
        <T muted size={11}>Money only moves when you confirm with your PIN or biometrics. {user?.role === 'admin' ? 'Administrative actions need a second administrator.' : ''}</T>
      </View>
    </Screen>
  );
}
