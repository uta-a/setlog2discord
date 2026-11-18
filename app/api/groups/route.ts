import { getClient, selfUserId, toErrorResponse } from "@/lib/bff";
import { toGroup, toMember } from "@/lib/setlog/transform";

export const dynamic = "force-dynamic";

/** GET /api/groups — 所属グループ一覧（ソロログ含む）。内部は GET /collections。 */
export async function GET(): Promise<Response> {
  try {
    const collections = await getClient().getCollections();
    const self = selfUserId();
    const groups = collections.map((c) => ({
      ...toGroup(c, self),
      members: c.participants.map(toMember),
    }));
    return Response.json({ groups });
  } catch (e) {
    return toErrorResponse(e);
  }
}
