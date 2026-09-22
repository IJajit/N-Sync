export class SyncLock {
  private static isLocked = false;

  public static async runWithLock<T>(taskName: string, fn: () => Promise<T>): Promise<T | null> {
    if (SyncLock.isLocked) {
      console.log(`[SyncLock] ${taskName} skipped: another sync operation is already in progress.`);
      return null;
    }

    SyncLock.isLocked = true;
    try {
      return await fn();
    } finally {
      SyncLock.isLocked = false;
    }
  }
}
