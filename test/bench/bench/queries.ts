import type postgres from '@internal/postgres/runtime';

type Sql = ReturnType<typeof postgres>['sql'];

const customerColumns = [
  'id',
  'company_name',
  'contact_name',
  'contact_title',
  'address',
  'city',
  'postal_code',
  'region',
  'country',
  'phone',
  'fax',
];
const employeeColumns = [
  'id',
  'last_name',
  'first_name',
  'title',
  'title_of_courtesy',
  'birth_date',
  'hire_date',
  'address',
  'city',
  'postal_code',
  'country',
  'home_phone',
  'extension',
  'notes',
  'recipient_id',
];
const supplierColumns = [
  'id',
  'company_name',
  'contact_name',
  'contact_title',
  'address',
  'city',
  'region',
  'postal_code',
  'country',
  'phone',
];
const productColumns = [
  'id',
  'name',
  'qt_per_unit',
  'unit_price',
  'units_in_stock',
  'units_on_order',
  'reorder_level',
  'discontinued',
  'supplier_id',
];
export function benchmarkPlans(sql: Sql) {
  const customers = sql.public.customers
    .select(...customerColumns)
    .orderBy('id')
    .limit(50)
    .offset(750)
    .build();
  const customerById = sql.public.customers
    .select(...customerColumns)
    .where((f, fns) => fns.eq(f.id, 4211))
    .limit(1)
    .build();
  const searchCustomer = sql.public.customers
    .select(...customerColumns)
    .where((f, fns) =>
      fns.raw`to_tsvector('english', ${f.company_name}) @@ to_tsquery('english', ${'ve:*'})`.returns(
        'pg/bool@1',
      ),
    )
    .build();
  const employees = sql.public.employees
    .select(...employeeColumns)
    .orderBy('id')
    .limit(50)
    .offset(0)
    .build();
  const employeeWithRecipient = sql.public.employees
    .as('e')
    .outerLeftJoin(sql.public.employees.as('r'), (f, fns) => fns.eq(f.e.recipient_id, f.r.id))
    .select((f) => ({
      id: f.e.id,
      last_name: f.e.last_name,
      first_name: f.e.first_name,
      title: f.e.title,
      title_of_courtesy: f.e.title_of_courtesy,
      birth_date: f.e.birth_date,
      hire_date: f.e.hire_date,
      address: f.e.address,
      city: f.e.city,
      postal_code: f.e.postal_code,
      country: f.e.country,
      home_phone: f.e.home_phone,
      extension: f.e.extension,
      notes: f.e.notes,
      recipient_id: f.e.recipient_id,
      recipient_id_r: f.r.id,
      recipient_last_name: f.r.last_name,
      recipient_first_name: f.r.first_name,
      recipient_title: f.r.title,
      recipient_title_of_courtesy: f.r.title_of_courtesy,
      recipient_birth_date: f.r.birth_date,
      recipient_hire_date: f.r.hire_date,
      recipient_address: f.r.address,
      recipient_city: f.r.city,
      recipient_postal_code: f.r.postal_code,
      recipient_country: f.r.country,
      recipient_home_phone: f.r.home_phone,
      recipient_extension: f.r.extension,
      recipient_notes: f.r.notes,
      recipient_recipient_id: f.r.recipient_id,
    }))
    .where((f, fns) => fns.eq(f.e.id, 137))
    .build();
  const suppliers = sql.public.suppliers
    .select(...supplierColumns)
    .orderBy('id')
    .limit(50)
    .offset(0)
    .build();
  const supplierById = sql.public.suppliers
    .select(...supplierColumns)
    .where((f, fns) => fns.eq(f.id, 631))
    .limit(1)
    .build();
  const products = sql.public.products
    .select(...productColumns)
    .orderBy('id')
    .limit(50)
    .offset(0)
    .build();
  const productWithSupplier = sql.public.products
    .outerLeftJoin(sql.public.suppliers, (f, fns) => fns.eq(f.products.supplier_id, f.suppliers.id))
    .select((f) => ({
      id: f.products.id,
      name: f.products.name,
      qt_per_unit: f.products.qt_per_unit,
      unit_price: f.products.unit_price,
      units_in_stock: f.products.units_in_stock,
      units_on_order: f.products.units_on_order,
      reorder_level: f.products.reorder_level,
      discontinued: f.products.discontinued,
      supplier_id: f.products.supplier_id,
      supplier_id_s: f.suppliers.id,
      supplier_company_name: f.suppliers.company_name,
      supplier_contact_name: f.suppliers.contact_name,
      supplier_contact_title: f.suppliers.contact_title,
      supplier_address: f.suppliers.address,
      supplier_city: f.suppliers.city,
      supplier_region: f.suppliers.region,
      supplier_postal_code: f.suppliers.postal_code,
      supplier_country: f.suppliers.country,
      supplier_phone: f.suppliers.phone,
    }))
    .where((f, fns) => fns.eq(f.products.id, 2874))
    .build();
  const searchProduct = sql.public.products
    .select(...productColumns)
    .where((f, fns) =>
      fns.raw`to_tsvector('english', ${f.name}) @@ to_tsquery('english', ${'ca:*'})`.returns(
        'pg/bool@1',
      ),
    )
    .build();
  const ordersWithDetails = sql.public.orders
    .outerLeftJoin(sql.public.order_details, (f, fns) =>
      fns.eq(f.orders.id, f.order_details.order_id),
    )
    .select((f, fns) => ({
      id: f.orders.id,
      shipped_date: f.orders.shipped_date,
      ship_name: f.orders.ship_name,
      ship_city: f.orders.ship_city,
      ship_country: f.orders.ship_country,
      productsCount: fns.raw`(${fns.count(f.order_details.product_id)})::int`.returns('pg/int4@1'),
      quantitySum: fns.raw`(${fns.sum(f.order_details.quantity)})::int`.returns('pg/int4@1'),
      totalPrice:
        fns.raw`(${fns.sum(fns.raw`${f.order_details.quantity} * ${f.order_details.unit_price}`.returns('pg/float8@1'))})::real`.returns(
          'pg/float4@1',
        ),
    }))
    .groupBy((f) => f.orders.id)
    .orderBy((f) => f.orders.id)
    .limit(50)
    .offset(750)
    .build();
  const orderWithDetails = sql.public.orders
    .outerLeftJoin(sql.public.order_details, (f, fns) =>
      fns.eq(f.orders.id, f.order_details.order_id),
    )
    .select((f, fns) => ({
      id: f.orders.id,
      shipped_date: f.orders.shipped_date,
      ship_name: f.orders.ship_name,
      ship_city: f.orders.ship_city,
      ship_country: f.orders.ship_country,
      productsCount: fns.raw`(${fns.count(f.order_details.product_id)})::int`.returns('pg/int4@1'),
      quantitySum: fns.raw`(${fns.sum(f.order_details.quantity)})::int`.returns('pg/int4@1'),
      totalPrice:
        fns.raw`(${fns.sum(fns.raw`${f.order_details.quantity} * ${f.order_details.unit_price}`.returns('pg/float8@1'))})::real`.returns(
          'pg/float4@1',
        ),
    }))
    .where((f, fns) => fns.eq(f.orders.id, 24601))
    .groupBy((f) => f.orders.id)
    .orderBy((f) => f.orders.id)
    .build();
  const orderWithDetailsAndProducts = sql.public.orders
    .outerLeftJoin(sql.public.order_details, (f, fns) =>
      fns.eq(f.orders.id, f.order_details.order_id),
    )
    .outerLeftJoin(sql.public.products, (f, fns) =>
      fns.eq(f.order_details.product_id, f.products.id),
    )
    .select((f) => ({
      id: f.orders.id,
      order_date: f.orders.order_date,
      required_date: f.orders.required_date,
      shipped_date: f.orders.shipped_date,
      ship_via: f.orders.ship_via,
      freight: f.orders.freight,
      ship_name: f.orders.ship_name,
      ship_city: f.orders.ship_city,
      ship_region: f.orders.ship_region,
      ship_postal_code: f.orders.ship_postal_code,
      ship_country: f.orders.ship_country,
      customer_id: f.orders.customer_id,
      employee_id: f.orders.employee_id,
      detail_unit_price: f.order_details.unit_price,
      detail_quantity: f.order_details.quantity,
      detail_discount: f.order_details.discount,
      detail_order_id: f.order_details.order_id,
      detail_product_id: f.order_details.product_id,
      product_id_p: f.products.id,
      product_name: f.products.name,
      product_qt_per_unit: f.products.qt_per_unit,
      product_unit_price: f.products.unit_price,
      product_units_in_stock: f.products.units_in_stock,
      product_units_on_order: f.products.units_on_order,
      product_reorder_level: f.products.reorder_level,
      product_discontinued: f.products.discontinued,
      product_supplier_id: f.products.supplier_id,
    }))
    .where((f, fns) => fns.eq(f.orders.id, 24601))
    .build();
  return {
    customers,
    customerById,
    searchCustomer,
    employees,
    employeeWithRecipient,
    suppliers,
    supplierById,
    products,
    productWithSupplier,
    searchProduct,
    ordersWithDetails,
    orderWithDetails,
    orderWithDetailsAndProducts,
    orderWithDetailsAndProductsLarge: orderWithDetailsAndProducts,
  };
}
