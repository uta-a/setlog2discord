import { getClient, toErrorResponse } from "@/lib/bff";
import { toDayView } from "@/lib/setlog/transform";

export const dynamic = "force-dynamic";

/**
 * GET /api/groups/:groupId/days/:date  (date = YYYY-MM-DD)
 * その日の 24 枠 × クリップ。現地 04:00 起点の日レンジで取得し、24 枠に整形。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ groupId: string; date: string }> },
): Promise<Response> {
  try {
    const { groupId, date } = await params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return Response.json(
        { error: "bad_request", message: "date=YYYY-MM-DD が必要" },
        { status: 400 },
      );
    }
    const messages = await getClient().getDayMessages(groupId, date);
    return Response.json(toDayView(groupId, date, messages));
  } catch (e) {
    return toErrorResponse(e);
  }
}
