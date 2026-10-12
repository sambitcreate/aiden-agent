def delivery_fee(subtotal_cents, member):
    return 0 if subtotal_cents >= 5000 else 499
