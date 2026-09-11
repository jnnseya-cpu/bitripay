import { useState } from 'react';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { Button, ConfirmButton, Field, Input, Modal, PageHeader, StatusBadge, Switch, Table, Textarea, fmtDate, useAsync } from '../components/ui';

export function Pages() {
  const { toast, config } = useStore();
  const list = useAsync(() => api.get<{ items: any[] }>('/api/admin/pages'), []);
  const [edit, setEdit] = useState<any>(null);
  const save = async () => {
    try {
      await api.put(`/api/admin/pages/${edit.slug}`, { title: edit.title, content: edit.content, published: edit.published });
      toast('Page saved', 'success');
      setEdit(null);
      list.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div>
      <PageHeader title="Pages" subtitle="About, FAQ, Terms, Privacy and any custom page (Markdown). Link them from Useful links." actions={<Button onClick={() => setEdit({ slug: '', title: '', content: '', published: true })}>+ New page</Button>} />
      <div className="card">
        <Table head={['Slug', 'Title', 'Status', 'Updated', '']} rows={(list.data?.items ?? []).map((p) => [<a href={`${config?.webUrl}/pages/${p.slug}`} target="_blank" rel="noreferrer" className="mono">/pages/{p.slug}</a>, p.title, <StatusBadge status={p.published ? 'active' : 'pending'} />, fmtDate(p.updatedAt), <div className="row"><Button size="sm" variant="secondary" onClick={() => setEdit({ ...p })}>Edit</Button><ConfirmButton size="sm" variant="ghost" onConfirm={() => api.del(`/api/admin/pages/${p.slug}`).then(list.reload)}>Delete</ConfirmButton></div>])} />
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.slug ? `Edit /pages/${edit.slug}` : 'New page'} wide>
        {edit && (
          <>
            <div className="grid cols-2">
              <Field label="Slug"><Input value={edit.slug} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} placeholder="about" /></Field>
              <Field label="Title"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            </div>
            <Field label="Content (Markdown: # headings, **bold**, - lists, [links](url))"><Textarea value={edit.content} onChange={(e) => setEdit({ ...edit, content: e.target.value })} style={{ minHeight: 320 }} /></Field>
            <Switch on={edit.published} onChange={(v) => setEdit({ ...edit, published: v })} label="Published" />
            <div className="mt"><Button onClick={save} disabled={!edit.slug || !edit.title}>Save page</Button></div>
          </>
        )}
      </Modal>
    </div>
  );
}
