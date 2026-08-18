import { NextResponse } from 'next/server';
import { getOAuth2Client } from '@/lib/google';

export async function GET() {
  const oauth2Client = getOAuth2Client();

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
