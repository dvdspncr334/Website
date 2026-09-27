(function() {
  function createOrderDetailKey() {
    return `jgv3d-order-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function hydrateOrdersWithDetailKeys(rawOrders) {
    const orders = Array.isArray(rawOrders) ? rawOrders : [];
    let didChange = false;

    const hydratedOrders = orders.map(order => {
      if (!order || typeof order !== 'object') {
        return order;
      }
      if (order.detailKey) {
        return order;
      }
      didChange = true;
      return Object.assign({}, order, { detailKey: createOrderDetailKey() });
    });

    return { orders: hydratedOrders, didChange };
  }

  function getOrderLookupKey(order) {
    if (!order || typeof order !== 'object') {
      return '';
    }
    return String(order.detailKey || order.id || '');
  }

  window.JGV3DOrderUtils = {
    createOrderDetailKey,
    getOrderLookupKey,
    hydrateOrdersWithDetailKeys
  };
})();
