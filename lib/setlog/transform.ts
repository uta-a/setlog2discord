/**
 * setlog の生レスポンス → 自前の内部型への変換。
 *
 * 「日」の境界は現地 04:00（設計書7章、動的解析で確定）。
 * Asia/Tokyo は DST が無いので UTC+9 固定で計算する。
 * hour 枠：04:00–05:00 が 0、…、03:00–04:00 が 23。
 */
import type { Collection, Message } from "./schema";
import type { Clip, DayView, Group, Member } from "./types";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_START_HOUR = 4;

/** JST の壁時計を UTC ゲッターで読むための Date を作る。 */
function jstWall(ts: number): Date {
  return new Date(ts + JST_OFFSET_MS);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** timestamp(ms) → 現地 04:00 起点の date(YYYY-MM-DD) と hour(0–23)。 */
export function toDateHour(ts: number): { date: string; hour: number } {
  const w = jstWall(ts);
  const localHour = w.getUTCHours();
  const hour = (localHour - DAY_START_HOUR + 24) % 24;
  // 04:00 未満は前日扱い。前日なら JST 壁時計から 1 日引いて日付を出す。
  const dayShift = localHour < DAY_START_HOUR ? DAY_MS : 0;
  const d = new Date(ts + JST_OFFSET_MS - dayShift);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { date, hour };
}

export function toMember(p: {
  userId: string;
  name: string;
  avatarUrl: string | null;
  tintColor?: string | null;
}): Member {
  return {
    sourceId: p.userId,
    displayName: p.name,
    avatarPath: p.avatarUrl ?? undefined,
    tintColor: p.tintColor ?? undefined,
  };
}

export function toGroup(c: Collection, selfUserId?: string): Group {
  const memberIds = c.participants.map((p) => p.userId);
  // selfUserId が分かればそれが自分だけかで判定。無ければ人数だけで判定。
  const isSolo =
    memberIds.length <= 1 &&
    (selfUserId === undefined || memberIds.length === 0 || memberIds[0] === selfUserId);
  return {
    sourceId: c.id,
    name: c.name,
    roomType: c.roomType,
    isSolo,
    memberIds,
  };
}

export function toClip(m: Message): Clip {
  const { date, hour } = toDateHour(m.timestamp);
  return {
    sourceId: m.messageId,
    groupId: m.conversationId,
    memberId: m.senderId,
    date,
    hour,
    capturedAt: new Date(m.timestamp).toISOString(),
    width: m.media.dimensions.width,
    height: m.media.dimensions.height,
    permission: m.media.permission,
    mediaPath: m.media.path,
    mimeType: m.media.mimeType,
  };
}

/**
 * メッセージ配列 → 24 枠の DayView。
 * 未投稿の枠も clips 空配列で必ず埋める。同一枠に複数あれば timestamp 昇順。
 */
export function toDayView(groupId: string, date: string, messages: Message[]): DayView {
  const slots = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    clips: [] as Clip[],
  }));
  for (const m of messages) {
    if (m.isDeleted) continue;
    const clip = toClip(m);
    // date が指定日と一致する枠だけに入れる（レンジ外の取りこぼし防止）
    if (clip.date !== date) continue;
    slots[clip.hour].clips.push(clip);
  }
  for (const s of slots) {
    s.clips.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  }
  return { groupId, date, slots };
}
