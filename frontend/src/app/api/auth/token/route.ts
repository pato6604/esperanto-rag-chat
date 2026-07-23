import { auth } from "@/lib/auth"
import { getToken } from "next-auth/jwt"
import { SignJWT } from "jose"

export const GET = auth(async (req) => {
  const token = await getToken({ req: req as any, secret: process.env.NEXTAUTH_SECRET })

  if (!token?.sub) {
    return Response.json({ token: null })
  }

  const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET
  if (!secret) {
    return Response.json({ token: null })
  }

  const backendToken = await new SignJWT({ sub: token.sub })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("24h")
    .sign(new TextEncoder().encode(secret))

  return Response.json({ token: backendToken })
})
