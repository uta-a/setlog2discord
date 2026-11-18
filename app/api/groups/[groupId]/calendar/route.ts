import { getClient, toErrorResponse } from "@/lib/bff";

export const dynamic = "force-dynamic";

/**
 * GET /api/groups/:groupId/calendar?month=YYYY-MM
 * 月内の投稿がある日。件数は返らない（カレンダー API が返さない）ので二値。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ groupId: string }> },
): Promise<Response> {
  try {
    const { groupId } = await params;
    const month = new URL(req.url).searchParams.get("month"); // "YYYY-MM"
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return Response.json({ error: "bad_request", message: "month=YYYY-MM が必要" }, { status: 400 });
    }
    const [year, mon] = month.split("-").map(Number);
    const r = await getClient().getCalendar(groupId, year, mon);
    return Response.json({ groupId, month, days: r.days });
  } catch (e) {
    return toErrorResponse(e);
  }
}
