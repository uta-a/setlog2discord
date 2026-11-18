/**
 * メンバーのプロフィール（名前・アイコン・色）の解決（設計書6章）。
 * WebSocket のメッセージには senderName が無いので、GET collections の参加者から userId で引く。
 *
 * - 知らない userId が来たら取り直す。取り直しても見つからなかった人は、minRefreshMs（既定 5 分）あけるまで取り直さない
 * - アイコンはメディア CDN にある（暗号化されていない。拡張子は .heic でも中身は JPEG だった。実測 2026-11-19）。
 *   Discord に URL を渡さず、取得した画像を添付して embed から参照する。画像はパスごとにメモリに持つ
 * - 取得に失敗しても投げない（名前やアイコンが分からないだけで投稿を落とさない）
 */
import { parseTintColor } from "../lib/setlog/media";
import { log } from "./log";

export type Participant = { userId: string; name: string; avatarUrl: string | null; tintColor?: string | null };

export type Profile = { name: string; avatarPath?: string; color?: number };

export type AvatarImage = { data: Buffer; ext: "jpg" | "png" | "webp" | "gif" };

export type MemberDirectory = {
  profile(userId: string): Promise<Profile | undefined>;
  avatar(path: string): Promise<AvatarImage | undefined>;
};

/** 先頭のバイトで画像の種類を見る。Discord が表示できない形式なら undefined。 */
export function sniffImage(data: Buffer): AvatarImage["ext"] | undefined {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (data.length >= 6 && data.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  return undefined;
}

export function createMemberDirectory(
  fetchParticipants: () => Promise<Participant[]>,
  fetchImage: (path: string) => Promise<Buffer>,
  opts: { minRefreshMs?: number; now?: () => number; maxAvatars?: number } = {},
): MemberDirectory {
  const minRefreshMs = opts.minRefreshMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  const maxAvatars = opts.maxAvatars ?? 200;
  const profiles = new Map<string, Profile>();
  /** 取り直しても見つからなかった userId と、その時刻（同じ人で何度も取り直さない）。 */
  const missing = new Map<string, number>();
  /** アイコン画像。取得に失敗したパスは null（アイコンが変わればパスも変わる）。 */
  const avatars = new Map<string, AvatarImage | null>();
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inflight ??= (async () => {
      try {
        for (const p of await fetchParticipants()) {
          profiles.set(p.userId, {
            name: p.name,
            avatarPath: p.avatarUrl || undefined,
            color: parseTintColor(p.tintColor),
          });
        }
      } catch (e) {
        log.warn(`メンバーの取得に失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    async profile(userId) {
      if (!profiles.has(userId)) {
        // 初めて見る userId（新しく入った友達など）は間隔に関係なく 1 回取り直す。
        // 見つからなかった人は minRefreshMs あけてから
        const lastMiss = missing.get(userId);
        if (lastMiss === undefined || now() - lastMiss >= minRefreshMs) {
          await refresh();
          if (!profiles.has(userId)) missing.set(userId, now());
        }
      }
      return profiles.get(userId);
    },

    async avatar(path) {
      if (avatars.has(path)) return avatars.get(path) ?? undefined;
      let image: AvatarImage | null = null;
      try {
        const data = await fetchImage(path);
        const ext = sniffImage(data);
        if (ext) image = { data, ext };
        else log.warn("アイコンが表示できない形式なので使わない");
      } catch (e) {
        // 一時的な失敗は覚えない（次の投稿でもう一度取りに行く）
        log.warn(`アイコンの取得に失敗: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
      if (avatars.size >= maxAvatars) avatars.delete(avatars.keys().next().value!);
      avatars.set(path, image);
      return image ?? undefined;
    },
  };
}
