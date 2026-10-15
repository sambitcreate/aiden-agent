def delivery_fee(subtotal_cents, member):
    return 0 if subtotal_cents >= 7500 else 499
