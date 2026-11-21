const PLATFORM_SW_PATTERN = /(?:^|\/)_service-worker\.js(?:$|[?#])/;
const guardedContainers = new WeakSet<object>();

/**
 * Prevents hosting-proxy scripts (such as the ./_service-worker.js that AI Studio's preview injected)
 * from registering a competing service worker on AllHail's root scope and causing
 * update prompts and reload loops.
 */
export function blockCompetingServiceWorker(
  container: ServiceWorkerContainer | undefined =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? navigator.serviceWorker
      : undefined,
  origin: string = typeof window !== 'undefined' ? window.location.origin : '',
): void {
  if (!container || typeof container.register !== 'function' || guardedContainers.has(container)) {
    return;
  }
  guardedContainers.add(container);

  const originalRegister = container.register.bind(container);
  container.register = function registerWithGuard(
    scriptURL: string | URL,
    options?: RegistrationOptions,
  ): Promise<ServiceWorkerRegistration> {
    const url = typeof scriptURL === 'string' ? scriptURL : String(scriptURL);
    if (PLATFORM_SW_PATTERN.test(url)) {
      return container.getRegistration(options?.scope ?? '/').then(
        (existing) => existing ?? ({ scope: `${origin}/` } as ServiceWorkerRegistration),
      );
    }
    return originalRegister(scriptURL, options);
  };
}
