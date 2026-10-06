import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, cancelOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, dispatchOrder, generateInvoice, getOrder, operationSummary, recordPayment, state, timeline, updateCustoms } from './domain.js';

const uniqueReference = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const lot = (id: string) => state.inventory.find(item => item.id === id)!;
const reservationsFor = (orderId: string) => state.reservations.filter(item => item.orderId === orderId);
const outboxFor = (orderId: string) => state.outbox.filter(item => item.aggregateId === orderId && item.topic === 'order.cancelled');

test('order lifecycle preserves credit, inventory, customs, shipment and invoice invariants', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueReference('TEST'), origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  assert.equal(order.status, 'draft');
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  const dispatched = dispatchOrder('tenant-acme', order.id, 'tester');
  assert.equal(dispatched.status, 'dispatched');
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  assert.ok(invoice.total > invoice.subtotal);
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: uniqueReference('PAY') }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.status, 'paid');
});

test('credit overage creates approval and approval increases only the required limit', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: uniqueReference('CREDIT'), origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  const approval = state.approvals.find(item => item.orderId === order.id && item.type === 'credit_override');
  assert.ok(approval);
  decideApproval('tenant-acme', approval!.id, { status: 'approved', comment: '额度复核通过' }, 'finance');
  assert.doesNotThrow(() => confirmOrder('tenant-acme', order.id, 'finance'));
});

test('operation summary exposes receivable and reservation metrics', () => {
  const summary = operationSummary('tenant-acme');
  assert.ok(summary.orderCount >= 1);
  assert.ok(summary.receivable >= 0);
  assert.ok(summary.inventory.every(item => item.available >= item.reserved));
});

test('cancellation releases every active reservation across SKUs, lots and warehouses exactly once', () => {
  const order = createOrder('tenant-acme', {
    customerId: 'CUS-001',
    reference: uniqueReference('CANCEL-CROSS-DC'),
    origin: '上海保税区',
    destination: '鹿特丹',
    items: [
      { sku: 'SENSOR-X9', description: '工业温度传感器', quantity: 70, unitPrice: 10, weightKg: 1, hsCode: '9025.19' },
      { sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 2, unitPrice: 20, weightKg: 1, hsCode: '8537.10' }
    ]
  });
  confirmOrder('tenant-acme', order.id, 'tester');

  lot('LOT-001').available = 50;
  lot('LOT-001').reserved = 0;
  lot('LOT-002').available = 100;
  lot('LOT-002').reserved = 0;
  lot('LOT-003').available = 20;
  lot('LOT-003').reserved = 0;
  const before1 = 0;
  const before2 = 0;
  const before3 = 0;
  allocateOrder('tenant-acme', order.id, 'tester');

  const reserved = reservationsFor(order.id);
  assert.equal(reserved.length, 3);
  assert.ok(reserved.some(item => item.lotId === 'LOT-001' && item.quantity === 50));
  assert.ok(reserved.some(item => item.lotId === 'LOT-002' && item.quantity === 2));
  assert.ok(reserved.some(item => item.lotId === 'LOT-003' && item.quantity === 20));
  assert.equal(lot('LOT-001').reserved - before1, 50);
  assert.equal(lot('LOT-002').reserved - before2, 2);
  assert.equal(lot('LOT-003').reserved - before3, 20);
  const cancelled = cancelOrder('tenant-acme', order.id, 'tester');
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(reservationsFor(order.id).every(item => item.status === 'released'));
  assert.equal(lot('LOT-001').reserved, before1);
  assert.equal(lot('LOT-002').reserved, before2);
  assert.equal(lot('LOT-003').reserved, before3);

  cancelOrder('tenant-acme', order.id, 'tester');
  const cancelledAgain = getOrder('tenant-acme', order.id);
  assert.equal(cancelledAgain.status, 'cancelled');
  assert.equal(outboxFor(order.id).length, 1);
  assert.equal(lot('LOT-001').reserved, before1);
  assert.equal(lot('LOT-002').reserved, before2);
  assert.equal(lot('LOT-003').reserved, before3);

  const events = timeline('tenant-acme', order.id);
  assert.equal(events[0].action, 'order.cancelled');
  assert.ok(events.some(item => item.action === 'reservation.released'));
  assert.ok(events.some(item => item.action === 'inventory.released'));
  const event = outboxFor(order.id)[0];
  const payload = event.payload as {
    order: { status: string };
    creditReleased: number;
    release: { releasedQuantity: number; inventory: { lotId: string; releasedQuantity: number }[] };
  };
  assert.equal(event.status, 'pending');
  assert.equal(payload.release.releasedQuantity, 72);
  assert.deepEqual(payload.release.inventory.map(item => [item.lotId, item.releasedQuantity]).sort(), [['LOT-001', 50], ['LOT-002', 2], ['LOT-003', 20]]);
  assert.equal(payload.order.status, 'cancelled');
  assert.equal(payload.creditReleased, 740);
});

test('cancellation rolls back only unconsumed quantities and leaves consumed lots deducted', () => {
  const order = createOrder('tenant-acme', {
    customerId: 'CUS-001',
    reference: uniqueReference('PARTIAL-CONSUMED'),
    origin: '上海保税区',
    destination: '鹿特丹',
    items: [{ sku: 'SENSOR-X9', description: '工业温度传感器', quantity: 50, unitPrice: 10, weightKg: 1, hsCode: '9025.19' }]
  });
  confirmOrder('tenant-acme', order.id, 'tester');
  const before1 = lot('LOT-001').reserved;
  const before3 = lot('LOT-003').reserved;
  lot('LOT-001').available = 30;
  lot('LOT-003').available = 20;
  allocateOrder('tenant-acme', order.id, 'tester');

  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  dispatchOrder('tenant-acme', order.id, 'tester');
  assert.equal(lot('LOT-001').available, 30 - 30);
  assert.equal(lot('LOT-003').available, 20 - 20);

  // 已出运订单在当前业务规则下不能取消。这里模拟出运后回滚到 allocated 的异常恢复入口。
  const allocatedOrder = state.orders.find(item => item.id === order.id)!;
  allocatedOrder.status = 'allocated';
  const cancelled = cancelOrder('tenant-acme', order.id, 'tester');
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(reservationsFor(order.id).every(item => item.status === 'consumed'));
  assert.equal(lot('LOT-001').reserved, before1);
  assert.equal(lot('LOT-003').reserved, before3);
  assert.equal(lot('LOT-001').available, 0);
  assert.equal(lot('LOT-003').available, 0);
  const recoveryPayload = outboxFor(order.id)[0].payload as { creditReleased: number; release: { releasedQuantity: number } };
  assert.equal(recoveryPayload.release.releasedQuantity, 0);
  assert.equal(recoveryPayload.creditReleased, 0);
});

test('duplicate cancellation recovers an orphan reservation and second retry is idempotent', () => {
  const order = createOrder('tenant-acme', {
    customerId: 'CUS-001',
    reference: uniqueReference('ORPHAN-RECOVERY'),
    origin: '上海保税区',
    destination: '鹿特丹',
    items: [{ sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '8537.10' }]
  });
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  cancelOrder('tenant-acme', order.id, 'tester');

  state.reservations.push({ id: 'RSV-ORPHAN-MISSING', tenantId: 'tenant-acme', orderId: order.id, lotId: 'LOT-MISSING', sku: 'CONTROL-M2', quantity: 3, status: 'active', createdAt: new Date().toISOString() });
  const mismatchedLot = lot('LOT-001');
  const reservedBeforeOrphan = mismatchedLot.reserved;
  mismatchedLot.reserved += 2;
  state.reservations.push({ id: 'RSV-ORPHAN-SKU', tenantId: 'tenant-acme', orderId: order.id, lotId: 'LOT-001', sku: 'CONTROL-M2', quantity: 2, status: 'active', createdAt: new Date().toISOString() });
  cancelOrder('tenant-acme', order.id, 'tester');

  assert.equal(state.reservations.find(item => item.id === 'RSV-ORPHAN-MISSING')?.status, 'released');
  assert.equal(state.reservations.find(item => item.id === 'RSV-ORPHAN-MISSING')?.releasedQuantity, 3);
  assert.equal(state.reservations.find(item => item.id === 'RSV-ORPHAN-SKU')?.status, 'released');
  assert.equal(state.reservations.find(item => item.id === 'RSV-ORPHAN-SKU')?.releasedQuantity, 2);
  assert.equal(mismatchedLot.reserved, reservedBeforeOrphan + 2);
  const events = outboxFor(order.id);
  assert.equal(events.length, 2);
  const recoveryEvent = events[0].payload as {
    creditReleased: number;
    release: { recoveredOrphans: boolean; releasedQuantity: number; inventoryReleasedQuantity: number; items: { orphan: boolean; lotId: string | null; inventoryReleased: number }[] };
  };
  assert.equal(recoveryEvent.release.recoveredOrphans, true);
  assert.equal(recoveryEvent.release.releasedQuantity, 5);
  assert.equal(recoveryEvent.release.inventoryReleasedQuantity, 0);
  assert.ok(recoveryEvent.release.items.every(item => item.inventoryReleased === 0));
  const orphanItems = recoveryEvent.release.items.map(item => [item.orphan, item.lotId]);
  assert.ok(orphanItems.some(([orphan, lotId]) => orphan && lotId === 'LOT-001'));
  assert.ok(orphanItems.some(([orphan, lotId]) => orphan && lotId === null));
  assert.equal(recoveryEvent.creditReleased, 0);

  cancelOrder('tenant-acme', order.id, 'tester');
  assert.equal(outboxFor(order.id).length, 2);
});

test('cancellation never releases another active order reservation sharing a damaged lot', () => {
  const cancelledOrder = createOrder('tenant-acme', {
    customerId: 'CUS-001',
    reference: uniqueReference('FAIR-CANCEL-A'),
    origin: '上海保税区',
    destination: '鹿特丹',
    items: [{ sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '8537.10' }]
  });
  const retainedOrder = createOrder('tenant-acme', {
    customerId: 'CUS-001',
    reference: uniqueReference('FAIR-CANCEL-B'),
    origin: '上海保税区',
    destination: '汉堡',
    items: [{ sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 3, unitPrice: 100, weightKg: 1, hsCode: '8537.10' }]
  });
  confirmOrder('tenant-acme', cancelledOrder.id, 'tester');
  confirmOrder('tenant-acme', retainedOrder.id, 'tester');
  lot('LOT-002').available = 10;
  lot('LOT-002').reserved = 0;
  allocateOrder('tenant-acme', cancelledOrder.id, 'tester');
  allocateOrder('tenant-acme', retainedOrder.id, 'tester');

  const lotState = lot('LOT-002');
  const reservedAfterAllocation = lotState.reserved;
  // 模拟 lot 账面预留少记 2：取消时只能回收本订单在剩余账面中的公平份额，不能吞掉 B 的预留。
  lotState.reserved -= 2;
  cancelOrder('tenant-acme', cancelledOrder.id, 'tester');

  assert.equal(lotState.reserved, 3);
  assert.equal(reservationsFor(retainedOrder.id).every(item => item.status === 'active'), true);
  assert.equal(reservedAfterAllocation - lotState.reserved, 2);
});

test('cancelled order cannot be allocated again and inventory remains reusable', () => {
  const order = createOrder('tenant-acme', {
    customerId: 'CUS-001',
    reference: uniqueReference('CANCEL-THEN-ALLOCATE'),
    origin: '上海保税区',
    destination: '鹿特丹',
    items: [{ sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 2, unitPrice: 10, weightKg: 1, hsCode: '8537.10' }]
  });
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const reservedAfterAllocation = lot('LOT-002').reserved;
  cancelOrder('tenant-acme', order.id, 'tester');
  assert.throws(() => allocateOrder('tenant-acme', order.id, 'tester'), /cancelled/);
  assert.equal(lot('LOT-002').reserved, reservedAfterAllocation);
});
