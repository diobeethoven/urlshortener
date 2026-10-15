export const base62Chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function base62Encode(id: number): string {
  if (id === 0) return base62Chars[0];
  let result = '';
  while (id > 0) {
    result = base62Chars[id % 62] + result;
    id = Math.floor(id / 62);
  }
  return result;
}

export function base62Decode(s: string): number {
  let id = 0;
  for (const c of s) {
    let v: number;
    if (c >= '0' && c <= '9') v = c.charCodeAt(0) - 48;
    else if (c >= 'A' && c <= 'Z') v = c.charCodeAt(0) - 65 + 10;
    else if (c >= 'a' && c <= 'z') v = c.charCodeAt(0) - 97 + 36;
    else throw new Error(`Invalid base62 character: ${c}`);
    id = id * 62 + v;
  }
  return id;
}

export async function generateUniqueCode(redis: any, prefix = 'url'): Promise<string> {
  // Use Redis INCR to atomically generate a unique numeric ID
  const n = await redis.incr(`urlshort:counter`);
  return base62Encode(n);
}

export async function tryCustomAlias(redis: any, alias: string): Promise<boolean> {
  // Check if alias already exists using EXISTS (returns 1 if key exists)
  const exists = await redis.exists(alias);
  return exists === 0; // return true if not exists (i.e., available)
}