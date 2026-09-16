import { useRef, useState, type ChangeEvent } from 'react';
import { tr } from '../lib/i18n';
import type { User } from '@bitripay/shared';
import { api } from '../lib/api';
import { Avatar, Button } from './ui';

/** Shrink the chosen file in the browser before upload; the output is a JPEG data URL. */
async function shrinkImage(file: File, maxW: number, maxH: number, quality = 0.86): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Unreadable image'));
      i.src = url;
    });
    const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unreadable image');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const SIZES = { profile: [512, 512], cover: [1600, 600] } as const;

/** An administrator's own profile and cover pictures, saved the moment they are chosen. */
export function ProfilePictures({ user, onSaved, onError }: { user: User; onSaved: () => void; onError: (message: string) => void }) {
  const profileInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'profile' | 'cover' | null>(null);
  const [saved, setSaved] = useState<'profile' | 'cover' | null>(null);
  const run = async (kind: 'profile' | 'cover', work: () => Promise<unknown>) => {
    setBusy(kind);
    try {
      await work();
      onSaved();
      setSaved(kind);
      setTimeout(() => setSaved((s) => (s === kind ? null : s)), 2500);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const upload = (kind: 'profile' | 'cover', e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return onError('Choose an image file');
    const [w, h] = SIZES[kind];
    void run(kind, async () => api.put(`/api/account/picture/${kind}`, { dataUrl: await shrinkImage(file, w, h) }));
  };
  const state = (kind: 'profile' | 'cover') => (busy === kind ? 'Saving…' : saved === kind ? 'Saved' : '');
  return (
    <div className="profile-pictures">
      <div className="cover-banner" style={user.coverUrl ? { backgroundImage: `url("${user.coverUrl}")` } : undefined}>
        {!user.coverUrl && <span className="cover-hint">{tr('No cover picture yet')}</span>}
        <div className="cover-actions">
          <Button size="sm" variant="secondary" onClick={() => coverInput.current?.click()} disabled={busy !== null}>
            {user.coverUrl ? tr('Change cover') : tr('Add cover')}
          </Button>
          {user.coverUrl && (
            <Button size="sm" variant="ghost" onClick={() => void run('cover', () => api.del(`/api/account/picture/cover`))} disabled={busy !== null}>
              {tr('Remove')}
            </Button>
          )}
          {state('cover') && <span className="tiny">{state('cover')}</span>}
        </div>
      </div>
      <div className="profile-pictures-row">
        <div className="profile-avatar-wrap">
          <Avatar user={user} size="lg" />
        </div>
        <div className="row wrap">
          <Button size="sm" variant="secondary" onClick={() => profileInput.current?.click()} disabled={busy !== null}>
            {user.pictureUrl ? tr('Change photo') : tr('Add photo')}
          </Button>
          {user.pictureUrl && (
            <Button size="sm" variant="ghost" onClick={() => void run('profile', () => api.del(`/api/account/picture/profile`))} disabled={busy !== null}>
              {tr('Remove')}
            </Button>
          )}
          {state('profile') && <span className="tiny">{state('profile')}</span>}
        </div>
      </div>
      <div className="tiny muted">{tr('Pictures save as soon as you choose them (JPEG, PNG or WebP).')}</div>
      <input ref={profileInput} type="file" accept="image/*" hidden onChange={(e) => upload('profile', e)} />
      <input ref={coverInput} type="file" accept="image/*" hidden onChange={(e) => upload('cover', e)} />
    </div>
  );
}
