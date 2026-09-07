import { NextRequest, NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';

export async function GET(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'n-sync.vercel.app';
  const proto = request.headers.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
  const dynamicRedirectUri = `${proto}://${host}/api/auth/google/callback`;

  const oauth2Client = getOAuth2Client(process.env.GOOGLE_REDIRECT_URI || dynamicRedirectUri);

  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
  ];

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
  });

  return NextResponse.redirect(url);
}
