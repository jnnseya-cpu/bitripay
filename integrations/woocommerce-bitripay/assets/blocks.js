(function () {
  const { registerPaymentMethod } = window.wc.wcBlocksRegistry;
  const { getSetting } = window.wc.wcSettings;
  const { createElement } = window.wp.element;
  const { decodeEntities } = window.wp.htmlEntities;
  const settings = getSetting('bitripay_data', {});
  const label = decodeEntities(settings.title || 'BitriPay');
  const Content = () =>
    createElement('div', null, decodeEntities(settings.description || ''), settings.testmode ? createElement('em', { style: { display: 'block', fontSize: '12px' } }, 'Test mode') : null);
  const Label = () => createElement('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, createElement('img', { src: settings.icon, alt: '', style: { height: 24 } }), label);
  registerPaymentMethod({
    name: 'bitripay',
    label: createElement(Label),
    content: createElement(Content),
    edit: createElement(Content),
    canMakePayment: () => true,
    ariaLabel: label,
    supports: { features: ['products', 'subscriptions'] },
  });
})();
