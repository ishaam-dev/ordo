import 'dotenv/config';

export interface Workspace {
  key: string;
  userToken: string;
  appToken: string;
}

/** A token counts as configured only if it is non-empty and not an obvious placeholder. */
export function tokenIfValid(value: string | undefined, prefix: string): string | null {
  const v = (value ?? '').trim();
  if (v === '') return null;
  if (v.includes('...')) return null; // placeholder like "xoxp-..."
  if (!v.startsWith(prefix)) return null;
  return v;
}

export function loadWorkspaces(): Workspace[] {
  const workspaces: Workspace[] = [];
  for (const key of ['A', 'B']) {
    const userRaw = process.env[`SLACK_${key}_USER_TOKEN`];
    const appRaw = process.env[`SLACK_${key}_APP_TOKEN`];
    const userToken = tokenIfValid(userRaw, 'xoxp-');
    const appToken = tokenIfValid(appRaw, 'xapp-');
    if (userToken && appToken) {
      workspaces.push({ key, userToken, appToken });
    } else if ((userRaw ?? '').trim() !== '' || (appRaw ?? '').trim() !== '') {
      console.warn(
        `[config] workspace ${key}: tokens present but incomplete or placeholder ` +
          `(need SLACK_${key}_USER_TOKEN starting with xoxp- and SLACK_${key}_APP_TOKEN starting with xapp-) — skipping`,
      );
    }
  }
  return workspaces;
}

export const workspaces: Workspace[] = loadWorkspaces();

export const PORT: number = (() => {
  const raw = (process.env.PORT ?? '').trim();
  const n = raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 5252;
})();
