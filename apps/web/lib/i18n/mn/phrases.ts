/**
 * Mongolian: sentences built from values (counts, names, dates). Mongolian
 * has no plural ending, so the English "1 …" / "{count} …" pairs share a form.
 */
export const phrases: Record<string, string> = {
  // Units and plurals (appointment helpers, availability).
  '1 day': '1 өдөр',
  '{count} days': '{count} өдөр',
  '1 hour': '1 цаг',
  '{count} hours': '{count} цаг',
  '1 minute': '1 минут',
  '{count} minutes': '{count} минут',
  '1 week': '1 долоо хоног',
  '{count} weeks': '{count} долоо хоног',
  '1 month': '1 сар',
  '{count} months': '{count} сар',
  '1 time': '1 удаа',
  '{count} times': '{count} удаа',
  'Every day': 'Өдөр бүр',
  'Every week': '7 хоног бүр',
  'Every month': 'Сар бүр',
  'Every {every}': '{every} тутам',
  ' on {days}': ' — {days}',
  ', until {date}': ', {date} хүртэл',
  Sun: 'Ня',
  Mon: 'Да',
  Tue: 'Мя',
  Wed: 'Лх',
  Thu: 'Пү',
  Fri: 'Ба',
  Sat: 'Бя',
  Ended: 'Дууссан',

  // Dashboard and charts.
  '{count} permissions in this company.': 'Энэ компанид {count} эрхтэй.',
  '1 permission in this company.': 'Энэ компанид 1 эрхтэй.',
  '{title}: chart. The same figures follow as a table.':
    '{title}: график. Ижил тоонууд доор хүснэгтээр.',
  ' · {amount} refunded': ' · {amount} буцаасан',
  '1 payment': '1 төлбөр',
  '{count} payments': '{count} төлбөр',
  '{newInWindow} in {windowDays} days': '{windowDays} хоногт {newInWindow}',
  'next {days} days': 'ирэх {days} хоног',
  today: 'өнөөдөр',
  '{from}–{to} of {total}': '{total}-ээс {from}–{to}',

  // Booking errors and rules.
  'Already booked at that time.': 'Тэр цагт аль хэдийн захиалагдсан.',
  'Cannot be booked.': 'Захиалах боломжгүй.',
  'Someone booked that time a moment ago. The list has been refreshed — please pick another slot.':
    'Хэн нэгэн тэр цагийг дөнгөж сая захиаллаа. Жагсаалт шинэчлэгдсэн — өөр цаг сонгоно уу.',
  'That date is too far ahead. Bookings open {days} in advance.':
    'Энэ огноо хэт хол байна. Захиалга {days}-ийн өмнөөс нээгдэнэ.',
  'That time is no longer available. The list has been refreshed — please pick another slot.':
    'Тэр цаг боломжгүй болсон. Жагсаалт шинэчлэгдсэн — өөр цаг сонгоно уу.',
  'That time is too soon. Bookings need at least {notice} notice.':
    'Тэр цаг хэт ойрхон байна. Захиалгыг дор хаяж {notice}-ийн өмнө хийнэ.',
  'That time is too soon: bookings need more notice.':
    'Тэр цаг хэт ойрхон байна: захиалгыг илүү эрт хийх шаардлагатай.',
  'That date is too far ahead to book yet.':
    'Энэ огноог одоогоор захиалах боломжгүй, хэт хол байна.',
  'That time has already passed.': 'Тэр цаг аль хэдийн өнгөрсөн.',
  'The chosen staff member is away (time off) at that time.':
    'Сонгосон ажилтан тэр цагт чөлөөтэй байна.',
  'The chosen staff member is not available at that time.': 'Сонгосон ажилтан тэр цагт боломжгүй.',
  'The room or equipment this service needs is unavailable at that time (maintenance or blocked).':
    'Энэ үйлчилгээнд шаардлагатай өрөө эсвэл тоног төхөөрөмж тэр цагт боломжгүй (засвар эсвэл хаагдсан).',
  'No room or equipment this service needs is free at that time.':
    'Энэ үйлчилгээнд шаардлагатай өрөө, тоног төхөөрөмж тэр цагт сул алга.',
  'This service is fully booked at that time (at most {max} at once).':
    'Энэ үйлчилгээ тэр цагт дүүрсэн (нэгэн зэрэг хамгийн ихдээ {max}).',
  'This service is fully booked at that time.': 'Энэ үйлчилгээ тэр цагт дүүрсэн.',
  'The branch is closed at that time.': 'Салбар тэр цагт хаалттай.',
  'Nobody who provides this service is free at that time.':
    'Энэ үйлчилгээг үзүүлдэг хэн ч тэр цагт сул алга.',
  'The promotion code could not be applied: {reason} Nothing was booked.':
    'Урамшууллын кодыг ашиглаж чадсангүй: {reason} Захиалга хийгдээгүй.',
  'This appointment has changed since you opened it. Reload to see its current status.':
    'Таныг нээснээс хойш энэ захиалга өөрчлөгдсөн. Одоогийн төлөвийг харахын тулд дахин ачаална уу.',
  'This service is not currently bookable.': 'Энэ үйлчилгээг одоогоор захиалах боломжгүй.',
  'Could not confirm.': 'Баталгаажуулж чадсангүй.',
  'Could not start.': 'Эхлүүлж чадсангүй.',
  'Could not complete.': 'Дуусгаж чадсангүй.',
  'Could not mark no-show.': 'Ирээгүй гэж тэмдэглэж чадсангүй.',

  // Appointments.
  ' · occupies {localTime}–{localTime2}': ' · {localTime}–{localTime2} эзэлнэ',
  'Same service and customer with {name}. The original is cancelled and a new appointment is created, linked to it.':
    '{name}-тэй ижил үйлчилгээ, ижил харилцагч. Анхны захиалга цуцлагдаж, түүнтэй холбоотой шинэ захиалга үүснэ.',
  'Same service and customer. The original is cancelled and a new appointment is created, linked to it.':
    'Ижил үйлчилгээ, ижил харилцагч. Анхны захиалга цуцлагдаж, түүнтэй холбоотой шинэ захиалга үүснэ.',
  '{total} in this view': 'Энэ харагдацад {total}',
  'Add a customer first': 'Эхлээд харилцагч нэмнэ үү',
  '{bookable} of {total} dates can be booked; {conflicts} cannot.':
    '{total} өдрөөс {bookable}-г захиалах боломжтой; {conflicts} боломжгүй.',
  '{bookable} of {total} dates can be booked.': '{total} өдрөөс {bookable}-г захиалах боломжтой.',
  'Between 1 and {MAXOCCURRENCES} occurrences.': '1-ээс {MAXOCCURRENCES} удаа.',
  'Book {value} appointments': '{value} захиалга хийх',
  occurrences: 'удаа',
  '{rule} at {time} · {upcoming} upcoming, {cancelled} cancelled of {total}':
    '{rule}, {time}-д · нийт {total}-ээс {upcoming} удахгүй, {cancelled} цуцлагдсан',
  '1 time · {duration}m · times in {timezone}': '1 цаг · {duration} мин · цагийн бүс {timezone}',
  '{count} times · {duration}m · times in {timezone}':
    '{count} цаг · {duration} мин · цагийн бүс {timezone}',
  '1 slot · {duration}m service · times in {timezone}':
    '1 сул цаг · {duration} мин үйлчилгээ · цагийн бүс {timezone}',
  '{count} slots · {duration}m service · times in {timezone}':
    '{count} сул цаг · {duration} мин үйлчилгээ · цагийн бүс {timezone}',

  // Auth.
  'Join {companyName}': '{companyName}-д нэгдэх',
  'This invitation is for {email}. Sign out and sign back in as that address to accept it.':
    'Энэ урилга {email}-д зориулагдсан. Хүлээн авахын тулд гараад тэр хаягаар дахин нэвтэрнэ үү.',
  'The two passwords do not match.': 'Хоёр нууц үг таарахгүй байна.',
  'Use at least {MINPASSWORDLENGTH} characters.':
    'Дор хаяж {MINPASSWORDLENGTH} тэмдэгт ашиглана уу.',

  // Availability explorer.
  ' · {count} resource candidates': ' · {count} боломжит нөөц',
  ' · {count} staff candidates': ' · {count} боломжит ажилтан',
  ' · 1 resource candidate': ' · 1 боломжит нөөц',
  ' · 1 staff candidate': ' · 1 боломжит ажилтан',
  ' · at most {max} at once': ' · нэгэн зэрэг хамгийн ихдээ {max}',
  'Books {hhmm}–{hhmm2}; ': '{hhmm}–{hhmm2} захиална; ',
  'occupies {hhmm}–{hhmm2}': '{hhmm}–{hhmm2} эзэлнэ',
  'Rules: at least {notice} notice · up to {days} days ahead':
    'Дүрэм: дор хаяж {notice}-ийн өмнө · {days} хоногийн өмнөөс',

  // Gift cards, promotions, payments.
  '{value} assigned to {customerName}.': '{customerName}-д {value} оноосон.',
  'Expires {toLocaleDateString}': '{toLocaleDateString}-нд дуусна',
  'of {amount}': '{amount}-аас',
  'Remove {name}': '{name}-г хасах',
  '{amount} refunded': '{amount} буцаасан',
  'Balance now {giftCardMoney}.': 'Одоогийн үлдэгдэл {giftCardMoney}.',
  'Could not {action} the card.': 'Картыг {action} чадсангүй.',
  'Redeemed {giftCardMoney}. ': '{giftCardMoney} зарцуулсан. ',
  'Refunded to the card. Balance now {giftCardMoney}.':
    'Картад буцаалаа. Одоогийн үлдэгдэл {giftCardMoney}.',
  'The remaining balance ({giftCardMoney}) is written off and the card can never be used again. To stop it temporarily, disable it instead.':
    'Үлдэгдэл ({giftCardMoney}) хүчингүй болж, картыг дахин хэзээ ч ашиглах боломжгүй. Түр зогсоох бол идэвхгүй болгоно уу.',
  '{total} cards': '{total} карт',
  '1 card': '1 карт',
  '1 payment · {money} net': '1 төлбөр · цэвэр {money}',
  '{total} payments · {money} net': '{total} төлбөр · цэвэр {money}',
  'Amount off ({currencyCode})': 'Хөнгөлөх дүн ({currencyCode})',
  automatic: 'автомат',
  'max {amount}': 'дээд тал нь {amount}',
  'Minimum spend ({currencyCode})': 'Хамгийн бага худалдан авалт ({currencyCode})',
  ' · {money} already refunded': ' · {money} аль хэдийн буцаасан',
  'Only {money} is still refundable.': 'Зөвхөн {money}-г буцаах боломжтой.',

  // Branch hours, calendar, catalog.
  '{day} closes': '{day} хаах цаг',
  '{day} opens': '{day} нээх цаг',
  'Open on {day}': '{day} нээлттэй',
  to: '—',
  ' · {count} waiting to retry': ' · {count} дахин оролдохыг хүлээж байна',
  '{count} appointments': '{count} захиалга',
  '1 appointment': '1 захиалга',
  'Could not delete “{name}”.': '“{name}”-г устгаж чадсангүй.',
  ' · {minutes} min including buffers': ' · завсартай нийт {minutes} мин',
  '{minutes} min': '{minutes} мин',
  'Enter an amount with at most {minorUnit} decimal places.':
    'Аравтын {minorUnit}-аас ихгүй оронтой дүн оруулна уу.',
  minutes: 'минут',
  'Price ({currencyCode})': 'Үнэ ({currencyCode})',

  // Customer portal.
  '{durationMin} minutes': '{durationMin} минут',
  'Cancel {what} on {when}?': '{when}-ний {what}-г цуцлах уу?',
  'Move to {when}': '{when} руу шилжүүлэх',
  'Times are in {timezone}.': 'Цагийн бүс: {timezone}.',
  'You have paid {amount}. The business handles any refund.':
    'Та {amount} төлсөн. Буцаалтыг бизнес шийднэ.',
  ' · expires {date}': ' · {date}-нд дуусна',
  'Hello, {firstName}': 'Сайн байна уу, {firstName}',
  'You bought this {amount} card for {name}. Its balance is theirs to see.':
    'Та энэ {amount}-ийн картыг {name}-д зориулж авсан. Үлдэгдлийг нь тэр хүн харна.',
  'You bought this {amount} card. Its balance is theirs to see.':
    'Та энэ {amount}-ийн картыг худалдаж авсан. Үлдэгдлийг нь эзэмшигч харна.',

  // Customers, staff, media, members.
  '{value} in total, newest first.': 'Нийт {value}, шинэ нь эхэндээ.',
  '({count} no-shows)': '({count} удаа ирээгүй)',
  '(1 no-show)': '(1 удаа ирээгүй)',
  branch: 'салбар',
  service: 'үйлчилгээ',
  'Remove {value}': '{value}-г хасах',
  'Remove the change on {date}': '{date}-ний өөрчлөлтийг хасах',
  'Change photo of {displayName}': '{displayName}-ийн зургийг солих',
  'Photo of {displayName}': '{displayName}-ийн зураг',
  '{name} break from': '{name} завсарлага эхлэх',
  '{name} break until': '{name} завсарлага дуусах',
  '{name} from': '{name} эхлэх',
  '{name} until': '{name} дуусах',
  'Works on {name}': '{name} ажиллана',
  '{label} preview': '{label} урьдчилан харах',
  'Choose {value}': '{value} сонгох',
  'The image is larger than {megabytes}.': 'Зураг {megabytes}-ээс том байна.',
  'Uploading {value}': '{value} байршуулж байна',
  '{name} for {label}': '{label}-д {name}',
  'Cancel the invitation for {email}': '{email}-ийн урилгыг цуцлах',
  'Change roles of {label}': '{label}-ийн үүргийг өөрчлөх',
  'It is shown only now.': 'Зөвхөн одоо харагдана.',
  '{count} permissions': '{count} эрх',
  '1 permission': '1 эрх',
  'Edit {name}': '{name}-г засах',

  // Notifications.
  ' (provider: {providerStatus})': ' (үйлчилгээ үзүүлэгч: {providerStatus})',
  ' via {providerLabel}': ' — {providerLabel}-ээр',
  'Reminders scheduled: {reminders}. Events turned into messages: {dispatched}. Sent: {sent}. Failed: {failed}.':
    'Товлосон сануулга: {reminders}. Мессеж болсон үйл явдал: {dispatched}. Илгээсэн: {sent}. Амжилтгүй: {failed}.',
  'Retry {label} to {recipientAddress}': '{recipientAddress} руу {label}-г дахин илгээх',
  '{value} account': '{value} бүртгэл',
  'Connect your own {value} account': 'Өөрийн {value} бүртгэлийг холбох',
  'Stored ({secretHint}) — leave blank to keep':
    'Хадгалсан ({secretHint}) — хэвээр үлдээх бол хоосон орхино уу',
  '{label} {value} template': '{label} — {value} загвар',

  // Onboarding.
  '{companyName} has finished onboarding.': '{companyName} тохируулгаа дуусгасан.',
  'Set up {value}': '{value}-г тохируулах',
  'Your branch and {services} services are set up.':
    'Таны салбар болон {services} үйлчилгээ тохируулагдлаа.',
  'Your branch and 1 service are set up.': 'Таны салбар болон 1 үйлчилгээ тохируулагдлаа.',
  'your company': 'таны компани',
  'Remove service {value}': '{value}-р үйлчилгээг хасах',

  // Public booking.
  ' To change or cancel, call {phone} and quote your reference.':
    ' Өөрчлөх эсвэл цуцлах бол {phone} руу залгаж, захиалгын дугаараа хэлнэ үү.',
  '{message} The code has been removed — confirm again to book at the full price, or try another code.':
    '{message} Код хасагдлаа — бүтэн үнээр захиалах бол дахин баталгаажуулах эсвэл өөр код оролдоно уу.',
  '{name} logo': '{name} лого',
  'Step {step} of {total}': 'Алхам {step}/{total}',

  // Subscription.
  '{name} is free. It takes effect now.': '{name} үнэгүй. Одоо хүчин төгөлдөр болно.',
  '{name} plan': '{name} багц',
  '{price}, starting today. An invoice is issued now; any unpaid invoice for your current plan is cancelled.':
    '{price}, өнөөдрөөс. Нэхэмжлэх одоо гарна; одоогийн багцын төлөгдөөгүй нэхэмжлэх цуцлагдана.',
  'A free {trialDays}-day trial of {name}. No invoice until you subscribe.':
    '{name}-ийн {trialDays} хоногийн үнэгүй туршилт. Захиалах хүртэл нэхэмжлэх гарахгүй.',
  'Choose {name}': '{name} сонгох',
  'Confirm {name}': '{name}-г батлах',
  'Downgrade to {name}': '{name} руу бууруулах',
  'Paid {day}': '{day}-нд төлсөн',
  'Renew {name}': '{name}-г сунгах',
  'Start {trialDays}-day trial': '{trialDays} хоногийн туршилт эхлүүлэх',
  'Subscribe to {name}': '{name}-д бүртгүүлэх',
  'Upgrade to {name}': '{name} руу ахиулах',

  // Page titles.
  'Undarga — Booking Platform': 'Undarga — Цаг захиалгын платформ',
  'Multi-tenant booking platform for companies with multiple branches.':
    'Олон салбартай компаниудад зориулсан цаг захиалгын платформ.',
  'Sign in — Undarga': 'Нэвтрэх — Undarga',
  'Forgot password — Undarga': 'Нууц үг сэргээх — Undarga',
  'Set a new password — Undarga': 'Шинэ нууц үг — Undarga',
  'Confirm your email — Undarga': 'Имэйл баталгаажуулах — Undarga',
  'Accept invitation — Undarga': 'Урилга хүлээн авах — Undarga',
  'Connecting calendar — Undarga': 'Календарь холбож байна — Undarga',

  // Time off.
  'Recorded. {employeeName} is now unavailable for bookings in that period.':
    'Бүртгэлээ. {employeeName} тэр хугацаанд захиалга авахгүй.',
};
