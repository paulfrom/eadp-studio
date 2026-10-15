/* Loaded in <head> before application imports or component stores execute. */
(function () {
  'use strict';
  var deny = function () {
    throw new Error('EADP_SYNTHETIC_ONLY: network access is blocked; use the local mock service');
  };
  var lock = function (target, key, value) {
    Object.defineProperty(target, key, { value: value, writable: false, configurable: false });
  };
  lock(window, 'fetch', function () {
    return Promise.reject(new Error('EADP_SYNTHETIC_ONLY: direct fetch is blocked'));
  });
  ['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker'].forEach(function (key) {
    lock(window, key, deny);
  });
  lock(navigator, 'sendBeacon', deny);
  if (navigator.serviceWorker) lock(navigator.serviceWorker, 'register', deny);
  lock(HTMLFormElement.prototype, 'submit', deny);
  document.addEventListener('submit', function (event) { event.preventDefault(); }, true);
  document.addEventListener('click', function (event) {
    var target = event.target;
    var anchor = target instanceof Element ? target.closest('a[href]') : null;
    if (anchor && new URL(anchor.href, location.href).origin !== location.origin) event.preventDefault();
  }, true);
  lock(window, '__EADP_MOCK_GUARD__', Object.freeze({ version: 'synthetic-only-v1', installed: true }));
}());
