import { useRef, useState, type ChangeEvent } from 'react';
import type { User } from '@bitripay/shared';
import { api } from '../lib/api';
import { tr } from '../lib/i18n';
import { Avatar, Button } from './ui';

/** Shrink a chosen file on the device before upload so a phone photo never leaves as 8 MB. Output is a JPEG data URL. */
export async function shrinkImage(file: File, maxW: number, maxH: number, quality = 0.86): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Unreadable image'));
      i.src = url;
    });
    const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unreadable image');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const SIZES = { profile: [512, 512], cover: [1600, 600] } as const;

/**
 * Profile and cover pictures with autosave: choosing a file uploads it at once, the saved state is shown, and a
 * picture can be removed. Works for every account type; `onUser` receives the refreshed account.
 */
export function ProfilePictures({ user, onUser, onError }: { user: User; onUser: (u: User) => void; onError: (message: string) => void }) {
  const profileInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'profile' | 'cover' | null>(null);
  const [saved, setSaved] = useState<'profile' | 'cover' | null>(null);

  const upload = async (kind: 'profile' | 'cover', e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return onError(tr('Choose an image file'));
    setBusy(kind);
    try {
      const [w, h] = SIZES[kind];
      const dataUrl = await shrinkImage(file, w, h);
      const r = await api.put<{ user: User }>(`/api/account/picture/${kind}`, { dataUrl });
      onUser(r.user);
      setSaved(kind);
      setTimeout(() => setSaved((s) => (s === kind ? null : s)), 2500);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (kind: 'profile' | 'cover') => {
    setBusy(kind);
    try {
      const r = await api.del<{ user: User }>(`/api/account/picture/${kind}`);
      onUser(r.user);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const state = (kind: 'profile' | 'cover') => (busy === kind ? tr('Saving…') : saved === kind ? tr('Saved') : '');

  return (
    <div className="profile-pictures">
      <div className="cover-banner" style={user.coverUrl ? { backgroundImage: `url("${user.coverUrl}")` } : undefined}>
        {!user.coverUrl && <span className="cover-hint">{tr('No cover picture yet')}</span>}
        <div className="cover-actions no-print">
          <Button size="sm" variant="secondary" onClick={() => coverInput.current?.click()} disabled={busy !== null}>
            {user.coverUrl ? tr('Change cover') : tr('Add cover')}
          </Button>
          {user.coverUrl && (
            <Button size="sm" variant="ghost" onClick={() => remove('cover')} disabled={busy !== null}>
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
        <div className="row wrap no-print">
          <Button size="sm" variant="secondary" onClick={() => profileInput.current?.click()} disabled={busy !== null}>
            {user.pictureUrl ? tr('Change photo') : tr('Add photo')}
          </Button>
          {user.pictureUrl && (
            <Button size="sm" variant="ghost" onClick={() => remove('profile')} disabled={busy !== null}>
              {tr('Remove')}
            </Button>
          )}
          {state('profile') && <span className="tiny">{state('profile')}</span>}
        </div>
      </div>
      <div className="tiny muted">{tr('Pictures save as soon as you choose them. JPEG, PNG or WebP; the photo is shown to people you pay or who pay you.')}</div>
      <input ref={profileInput} type="file" accept="image/*" hidden onChange={(e) => void upload('profile', e)} />
      <input ref={coverInput} type="file" accept="image/*" hidden onChange={(e) => void upload('cover', e)} />
    </div>
  );
}
