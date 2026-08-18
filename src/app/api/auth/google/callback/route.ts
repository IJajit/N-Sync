import { NextRequest, NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.json({ error: 'No code provided in callback' }, { status: 400 });
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    return NextResponse.json({
      message: 'Successfully authenticated with Google!',
      instructions: 'Copy the refresh_token below and add it to your .env.local file as GOOGLE_REFRESH_TOKEN',
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
    });
  } catch (error: any) {
    console.error('Error exchanging OAuth code:', error);
    return NextResponse.json({ error: error?.message || 'Failed to exchange token' }, { status: 500 });
  }
}
