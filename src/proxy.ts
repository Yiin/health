import { NextResponse, type NextRequest } from "next/server";

import {
  authenticationRequiredResponse,
  isRequestAuthorized,
} from "@/lib/basic-auth";

export function proxy(request: NextRequest) {
  if (isRequestAuthorized(request)) {
    return NextResponse.next();
  }

  return authenticationRequiredResponse();
}

export const config = {
  // /api/health stays open so Docker/Coolify healthchecks keep working.
  // /api/uploads is excluded because a matched proxy makes Next buffer the
  // request body (middlewareClientMaxBodySize, 10MB by default), truncating
  // multi-GB streams; the route enforces the same basic-auth check itself.
  matcher: [
    "/((?!api/health|api/uploads|_next/static|_next/image|favicon.ico).*)",
  ],
};
