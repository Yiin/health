import { NextResponse, type NextRequest } from "next/server";

import { isAuthorized } from "@/lib/basic-auth";

export function proxy(request: NextRequest) {
  const authorized = isAuthorized(
    {
      user: process.env.BASIC_AUTH_USER,
      pass: process.env.BASIC_AUTH_PASS,
    },
    request.headers.get("authorization"),
  );

  if (authorized) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="health"' },
  });
}

export const config = {
  // /api/health stays open so Docker/Coolify healthchecks keep working.
  matcher: ["/((?!api/health|_next/static|_next/image|favicon.ico).*)"],
};
