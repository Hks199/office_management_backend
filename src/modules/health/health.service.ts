export class HealthService {
  constructor(private readonly isDatabaseReady: () => Promise<boolean>) {}

  async ready(): Promise<boolean> {
    try { return await this.isDatabaseReady(); }
    catch { return false; }
  }
}
