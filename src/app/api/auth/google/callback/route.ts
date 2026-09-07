import { NextRequest, NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.json({ error: 'No code provided in callback' }, { status: 400 });
  }

  try {
    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'n-sync.vercel.app';
    const proto = request.headers.get('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
    const dynamicRedirectUri = `${proto}://${host}/api/auth/google/callback`;

    const oauth2Client = getOAuth2Client(process.env.GOOGLE_REDIRECT_URI || dynamicRedirectUri);
    const { tokens } = await oauth2Client.getToken(code);

    return NextResponse.json({
      message: 'Successfully authenticated with Google!',
      instructions: 'Copy the refresh_token below and add it to your Vercel / .env.local as GOOGLE_REFRESH_TOKEN',
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
    });
  } catch (error: any) {
    console.error('Error exchanging OAuth code:', error);
    return NextResponse.json({ error: error?.message || 'Failed to exchange token' }, { status: 500 });
  }
}
