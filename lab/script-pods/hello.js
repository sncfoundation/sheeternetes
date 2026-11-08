// A script pod: no Docker, no kubelet — the cluster's own Apps Script runs it.
//   skctl volume create code && skctl volume put code hello.js lab/script-pods/hello.js
//   skctl volume create media --ro && skctl volume put media pixel.gif lab/script-pods/pixel.gif
//   skctl apply lab/script-pods/hello.json
exports.handle = function (event, env) {
  const s = env.state.get();
  if (event.type === 'schedule') {
    s.slots = (s.slots || []).concat(event.slot).slice(-20);      // each slot exactly once
    console.log('tick', event.slot, env.vars.GREETING);
  } else if (event.type === 'webhook') {
    // a sender's own event id makes redeliveries harmless
    const id = event.json && event.json.id;
    env.once('hook:' + id, () => { s.webhooks = (s.webhooks || 0) + 1; });
    console.log('webhook', id);
  }
  return { slots: (s.slots || []).length, webhooks: s.webhooks || 0 };
};

// skctl run hello -- pixel
exports.pixel = function (event, env) {
  const gif = env.volumes.media.read('pixel.gif');
  return { bytes: gif.getBytes().length, type: gif.getContentType(), sha256: env.volumes.media.list()[0].sha256 };
};
