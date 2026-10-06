import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, cancelOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, dispatchOrder, generateInvoice, operationSummary, recordPayment, state, updateCustoms } from './domain.js';

test('order lifecycle preserves credit, inventory, customs, shipment and invoice invariants', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `TEST-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
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
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${Date.now()}` }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.status, 'paid');
});

test('credit overage creates approval and approval increases only the required limit', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: `CREDIT-${Date.now()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
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

const uniqueRef = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const lotById = (lotId: string) => state.inventory.find(item => item.id === lotId)!;
const orderReservations = (orderId: string) => state.reservations.filter(item => item.orderId === orderId);
const orderOutbox = (orderId: string) => state.outbox.filter(item => item.aggregateId === orderId) as Array<{ id: string; topic: string; payload: any }>;
const orderAudit = (orderId: string) => state.audit.filter(item => item.entityId === orderId);

test('cancel releases every cross-warehouse, cross-lot reservation and is replay-idempotent', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueRef('CANCEL-MULTI'), origin: '上海保税区', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 69, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');

  const reservations = orderReservations(order.id);
  assert.ok(reservations.length >= 2, '跨仓订单应拆到多个 lot');
  const reservedBefore = new Map(reservations.map(r => [r.lotId, lotById(r.lotId).reserved]));
  const customerBefore = state.customers.find(c => c.id === 'CUS-001')!.creditUsed;

  const cancelled = cancelOrder('tenant-acme', order.id, 'tester');
  assert.equal(cancelled.status, 'cancelled');

  // 每个 lot 都按该订单真实预留数量回退，库存可被后续订单重新使用
  for (const reservation of reservations) {
    assert.equal(reservation.status, 'released');
    assert.ok(reservation.releasedAt, 'released reservation 应记录释放时间');
    assert.equal(lotById(reservation.lotId).reserved, reservedBefore.get(reservation.lotId)! - reservation.quantity);
  }
  const customerAfter = state.customers.find(c => c.id === 'CUS-001')!.creditUsed;
  assert.equal(customerAfter, customerBefore - cancelled.totalAmount);

  // audit 与 outbox 都必须反映释放结果，且与 lot 状态一致（不允许库存释放了但事件还显示占用）
  const releaseEvent = orderOutbox(order.id).find(e => e.topic === 'inventory.released');
  assert.ok(releaseEvent, '取消必须发布 inventory.released 事件');
  assert.equal(releaseEvent!.payload.releaseOutcome.releases.length, reservations.length);
  assert.ok(orderAudit(order.id).some(a => a.action === 'inventory.released'));

  // 幂等：重复取消不抛错、不重复释放、不重复退额度，也不重复发事件
  cancelOrder('tenant-acme', order.id, 'tester');
  cancelOrder('tenant-acme', order.id, 'tester');
  assert.equal(state.customers.find(c => c.id === 'CUS-001')!.creditUsed, customerAfter);
  assert.equal(orderOutbox(order.id).filter(e => e.topic === 'inventory.released').length, 1);
  for (const reservation of reservations) assert.equal(lotById(reservation.lotId).reserved, reservedBefore.get(reservation.lotId)! - reservation.quantity);
  assert.ok(reservations.every(r => r.status === 'released'));
});

test('cancel is recoverable when interrupted after only the first reservation was released', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueRef('CANCEL-RESUME'), origin: '上海保税区', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 69, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');

  const reservations = orderReservations(order.id);
  const before = new Map(reservations.map(r => [r.lotId, lotById(r.lotId).reserved]));

  // 模拟旧实现/中断：订单已取消、仅首个 reservation 被释放，其余残留 active
  const first = reservations[0];
  lotById(first.lotId).reserved -= first.quantity;
  first.status = 'released';
  first.releasedAt = new Date().toISOString();
  const stored = state.orders.find(o => o.id === order.id)!;
  stored.status = 'cancelled';

  // 再次取消应作为恢复执行，只处理仍有效的残留 reservation
  cancelOrder('tenant-acme', order.id, 'tester');
  for (const reservation of reservations) {
    assert.equal(reservation.status, 'released');
    assert.equal(lotById(reservation.lotId).reserved, before.get(reservation.lotId)! - reservation.quantity);
  }
  // 恢复只补发一次 inventory.released，覆盖残留的 lot
  const events = orderOutbox(order.id).filter(e => e.topic === 'inventory.released');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.recovered, true);
  assert.equal(events[0].payload.releaseOutcome.releases.length, reservations.length - 1);
});

test('cancel tolerates orphan reservations and reserved drift without negative balances', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueRef('CANCEL-ORPHAN'), origin: '上海保税区', destination: '鹿特丹', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 4, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const reservations = orderReservations(order.id);
  const lotId = reservations[0].lotId;
  const reservedBefore = lotById(lotId).reserved;

  // 注入孤立 reservation（lot 已不存在）
  state.reservations.push({ id: 'RSV-ORPHAN-1', tenantId: 'tenant-acme', orderId: order.id, lotId: 'LOT-GONE', sku: 'SENSOR-X9', quantity: 3, status: 'active', createdAt: new Date().toISOString() });
  // 注入 lot.reserved 漂移：挂账小于有效预留合计
  const driftReservation = state.reservations.find(r => r.lotId === lotId)!;
  lotById(lotId).reserved = 1;
  assert.ok(driftReservation.quantity > 1);

  assert.doesNotThrow(() => cancelOrder('tenant-acme', order.id, 'tester'));

  const orphan = state.reservations.find(r => r.id === 'RSV-ORPHAN-1')!;
  assert.equal(orphan.status, 'released');
  assert.equal(lotById(lotId).reserved, 0);
  assert.ok(lotById(lotId).reserved >= 0, '漂移回退不能把 reserved 扣成负数');
  assert.equal(reservedBefore >= 0, true);

  const anomalyActions = orderAudit(order.id).filter(a => a.action === 'reservation.release.anomaly');
  const codes = anomalyActions.map(a => (a.after as { code: string }).code).sort();
  assert.deepEqual(codes, ['lot_missing', 'reserved_drift']);

  // 重复取消后状态依旧稳定、无新异常发生
  cancelOrder('tenant-acme', order.id, 'tester');
  assert.equal(lotById(lotId).reserved, 0);
});

test('cancel leaves partially consumed reservations (dispatch) rejected but active-only releases stay exact', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueRef('CANCEL-CONSUMED'), origin: '上海保税区', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  dispatchOrder('tenant-acme', order.id, 'tester');
  assert.ok(orderReservations(order.id).every(r => r.status === 'consumed'));
  assert.throws(() => cancelOrder('tenant-acme', order.id, 'tester'), /已出运订单不能取消/);
  assert.equal(state.orders.find(o => o.id === order.id)!.status, 'dispatched');
});

test('allocate never over-commits the free (available - reserved) stock and failed allocation rolls back', () => {
  // CONTROL-M2: available 36, seed 已 reserved 4，且 seed 出运后 available=32/reserved=0；取一个全新 SKU 场景
  const lot = state.inventory.find(l => l.sku === 'CONTROL-M2')!;
  const freeBefore = lot.available - lot.reserved;

  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueRef('ALLOC-OVERCOMMIT'), origin: '上海', destination: '汉堡', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 35, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  confirmOrder('tenant-acme', order.id, 'tester');
  // 可用量不足 35，分配必须失败而不是按 available 超卖
  assert.throws(() => allocateOrder('tenant-acme', order.id, 'tester'), /库存不足/);
  assert.equal(lot.available - lot.reserved, freeBefore, '失败回滚后可用量必须恢复');
  assert.ok(orderReservations(order.id).every(r => r.status !== 'active'), '失败后不能残留 active reservation');
  assert.equal(state.orders.find(o => o.id === order.id)!.status, 'confirmed');
});

test('released stock is reusable by a later order after cross-warehouse cancel', () => {
  const freeSensor = () => state.inventory.filter(l => l.sku === 'SENSOR-X9').reduce((sum, l) => sum + (l.available - l.reserved), 0);
  const lot001Free = () => lotById('LOT-001').available - lotById('LOT-001').reserved;
  const lot003Free = () => lotById('LOT-003').available - lotById('LOT-003').reserved;
  const totalFree = freeSensor();
  // 订走全部可用量（大于任一单仓可用量，必然跨上海/鹿特丹两个仓）
  const first = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueRef('REUSE-A'), origin: '上海保税区', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: totalFree, unitPrice: 1, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', first.id, 'tester');
  allocateOrder('tenant-acme', first.id, 'tester');
  const reservedByFirst = new Map(orderReservations(first.id).map(r => [r.lotId, r.quantity]));
  assert.ok(reservedByFirst.size >= 2, '首个订单应跨仓预留');
  cancelOrder('tenant-acme', first.id, 'tester');
  assert.equal(freeSensor(), totalFree, '取消后总可用量必须完全恢复');

  // 占用上海仓大部分余量，迫使新订单同时使用刚释放的上海仓与鹿特丹仓
  const blockerQty = lot001Free() - 2;
  const blocker = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueRef('REUSE-BLOCK'), origin: '上海保税区', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: blockerQty, unitPrice: 1, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', blocker.id, 'tester');
  allocateOrder('tenant-acme', blocker.id, 'tester');

  // 剩余量分布：上海仓 2、鹿特丹仓全部，新订单取 2 + 鹿特丹余量，必然再次跨仓
  const secondQty = 2 + lot003Free();
  const second = createOrder('tenant-acme', { customerId: 'CUS-001', reference: uniqueRef('REUSE-B'), origin: '上海保税区', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: secondQty, unitPrice: 1, weightKg: 1, hsCode: '9025.19' }] });
  confirmOrder('tenant-acme', second.id, 'tester');
  assert.doesNotThrow(() => allocateOrder('tenant-acme', second.id, 'tester'));
  const secondReservations = orderReservations(second.id);
  assert.ok(secondReservations.length >= 2, '新订单应能跨仓复用刚释放的库存');
  assert.ok(secondReservations.some(r => r.lotId === 'LOT-001'), '新订单应重新占用上海仓 LOT-001');
  assert.ok(secondReservations.some(r => r.lotId === 'LOT-003'), '新订单应重新占用鹿特丹仓 LOT-003');
});
