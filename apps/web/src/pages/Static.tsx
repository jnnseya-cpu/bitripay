import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Alert, Button, Field, Input, Loading, Textarea, useAsync } from '../components/ui';

/** Minimal markdown renderer for CMS pages (headings, bold, paragraphs, lists, links). */
function renderMarkdown(md: string) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');
  const lines = md.split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    if (/^\s*[-*] /.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(line.replace(/^\s*[-*] /, ''))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    const h = line.match(/^(#{1,3}) (.*)/);
    if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav className="landing-nav"><Link to="/" className="brand" style={{ color: 'inherit', padding: 0 }}><span className="brand-logo">B</span>BitriPay</Link><Link to="/app" className="btn secondary">Open app</Link></nav>
      <div className="content" style={{ maxWidth: 800 }}>{children}</div>
    </div>
  );
}

export function StaticPage() {
  const { slug } = useParams();
  const page = useAsync(() => api.get<{ title: string; content: string }>(`/api/pages/${slug}`), [slug]);
  if (page.error) return <Shell><Alert kind="error">Page not found</Alert></Shell>;
  if (!page.data) return <Loading />;
  return <Shell><div className="card md" dangerouslySetInnerHTML={{ __html: renderMarkdown(page.data.content) }} /></Shell>;
}

export function Contact() {
  const { config } = useStore();
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Shell>
      <div className="card">
        <h2>Contact us</h2>
        <p className="muted">{config?.site?.contactEmail} {config?.site?.contactPhone && `· ${config.site.contactPhone}`}</p>
        {sent ? <Alert kind="success">Thanks! We'll get back to you shortly.</Alert> : (
          <form onSubmit={(e) => { e.preventDefault(); api.post('/api/contact', form).then(() => setSent(true)).catch((err) => setError(err.message)); }}>
            {error && <Alert kind="error">{error}</Alert>}
            <div className="grid cols-2"><Field label="Name"><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field><Field label="Email"><Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field></div>
            <Field label="Subject"><Input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
            <Field label="Message"><Textarea required value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
            <Button>Send message</Button>
          </form>
        )}
      </div>
    </Shell>
  );
}
