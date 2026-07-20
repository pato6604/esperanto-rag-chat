import { auth } from "@/lib/auth"
import { getToken } from "next-auth/jwt"

export const GET = auth(async (req) => {
  const token = await getToken({
    req: req as any,
    raw: true,
    secret: process.env.NEXTAUTH_SECRET,
  })
  return Response.json({ token })
})
