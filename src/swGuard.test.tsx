import { describe, expect, it, vi } from 'vitest';
import { blockCompetingServiceWorker } from './swGuard.ts';

describe('blockCompetingServiceWorker', () => {
  it('blocks proxy-injected _service-worker.js registrations while allowing /sw.js', async () => {
    const nativeRegister = vi.fn().mockResolvedValue({ scope: 'https://allhail.ai.studio/' });
    const getRegistration = vi.fn().mockResolvedValue(undefined);
    const container = {
      register: nativeRegister,
      getRegistration,
    } as unknown as ServiceWorkerContainer;

    blockCompetingServiceWorker(container, 'https://allhail.ai.studio');
    // Calling twice is idempotent.
    blockCompetingServiceWorker(container, 'https://allhail.ai.studio');

    const proxyReg = await container.register('./_service-worker.js');
    expect(nativeRegister).not.toHaveBeenCalled();
    expect(proxyReg.scope).toBe('https://allhail.ai.studio/');

    await container.register('/_service-worker.js?v=1');
    expect(nativeRegister).not.toHaveBeenCalled();

    await container.register('/sw.js', { scope: '/' });
    expect(nativeRegister).toHaveBeenCalledTimes(1);
    expect(nativeRegister).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });
});
