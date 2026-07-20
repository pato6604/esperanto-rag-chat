"use client"

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { useSession } from "next-auth/react"

interface AuthContextValue {
  token: string | null
  isAuthenticated: boolean
  user: { name?: string | null; email?: string | null; image?: string | null } | null
}

const AuthContext = createContext<AuthContextValue>({
  token: null,
  isAuthenticated: false,
  user: null,
})

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession()
  const [token, setToken] = useState<string | null>(null)

  useEffect(() => {
    if (status === "authenticated" && session?.user) {
      fetch("/api/auth/token")
        .then((res) => res.json())
        .then((data) => {
          if (data.token) {
            setToken(data.token)
          }
        })
        .catch(() => {
          // Token fetch failed - keep working without auth (dev mode)
        })
    } else {
      setToken(null)
    }
  }, [status, session])

  const user = status === "authenticated" && session?.user
    ? { name: session.user.name, email: session.user.email, image: session.user.image }
    : null

  return (
    <AuthContext.Provider value={{ token, isAuthenticated: status === "authenticated", user }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
