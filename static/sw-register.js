if ('serviceWorker' in navigator) {
  // Capture controller state at script-load. Used to decide whether a
  // subsequent controllerchange is a deploy-pickup (had a prior SW, so
  // reload so the new bundle takes over) or a first install (no prior SW,
  // so skip the reload during the initial React mount).
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('SW registered:', registration.scope);
      })
      .catch((error) => {
        console.log('SW registration failed:', error);
      });
  });
}
