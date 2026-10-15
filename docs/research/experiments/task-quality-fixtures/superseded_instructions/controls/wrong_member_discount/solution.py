def delivery_fee(subtotal_cents, member):
    return 0 if member or subtotal_cents >= 7500 else 499
