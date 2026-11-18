/**
 * 自前の内部型（設計書7章）。setlog 側の ID は sourceId として保持する。
 * フェーズ2 ではこのまま D1 のテーブルになる。
 */

export type Member = {
  sourceId: string; // setlog の userId
  displayName: string;
  avatarPath?: string; // media.newchatapi.com の後続パス（ホスト省略）
  tintColor?: string;
};

export type Group = {
  sourceId: string; // setlog の collection id
  name: string;
  roomType: string; // "log" | "vlog" | "stack"
  isSolo: boolean; // 参加者が自分だけか
  memberIds: string[]; // sourceId の配列
};

export type Clip = {
  sourceId: string; // setlog の messageId
  groupId: string; // collection id
  memberId: string; // senderId
  date: string; // YYYY-MM-DD（現地 04:00 起点。04:00 未満は前日扱い）
  hour: number; // 0–23 の枠（04:00 起点。timestamp から算出）
  capturedAt: string; // ISO 8601
  width: number;
  height: number;
  permission: string; // "allow_saving" など
  mediaPath: string; // media.newchatapi.com の後続パス
  mimeType: string; // "video/mp4"
};

/** 1日分。slots は常に 24 件。空の枠は clips 空配列。 */
export type DayView = {
  groupId: string;
  date: string;
  slots: { hour: number; clips: Clip[] }[];
};
