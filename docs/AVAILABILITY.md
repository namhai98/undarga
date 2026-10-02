# Availability Engine

Захиалгын сул цагийг тооцоолдог модуль. Зөвхөн **уншина** — цаг захиалга,
хүлээлт (hold), төлбөр үүсгэхгүй. Дараагийн үе шат болох Appointment Engine
захиалгыг гүйлгээ дотор давхар шалгаж баталгаажуулна.

## Юу нэмэгдсэн

| Давхарга | Файл |
|---|---|
| Цагийн бүсийн хөрвүүлэлт (DST-зөв, хамааралгүй) | `apps/api/src/common/time/zoned-time.ts` |
| Интервалын математик (давхцал, хасалт, нэгтгэл) | `apps/api/src/availability/interval.ts` |
| Цэвэр тооцооллын цөм | `apps/api/src/availability/availability.engine.ts` |
| Өгөгдөл ачаалах (нэг гүйлгээ, N+1 байхгүй) | `apps/api/src/availability/availability.repository.ts` |
| Найруулга: цагийн бүс + цөм + хэлбэржүүлэлт | `apps/api/src/availability/availability.service.ts` |
| REST endpoint | `apps/api/src/availability/availability.controller.ts` |
| `availability:read` эрх | `packages/shared/src/permissions.ts`, `apps/api/src/authz/permissions.ts` |
| `SERVICE_NOT_BOOKABLE` алдааны код | `packages/shared/src/api-contract.ts`, `.../common/errors/domain.errors.ts` |
| Дотоод шалгах UI | `apps/web/features/availability/` |

Prisma схем **өөрчлөгдөөгүй** — схемд аль хэдийн байсан загваруудыг л ашигласан
(`business_hours`, `employee_schedule`, `employee_schedule_break`,
`employee_schedule_exception`, `employee_time_off`, `branch_closure`, `service`,
`service_branch`, `service_availability_rule`, `service_resource_requirement`,
`resource`, `appointment_item`, `appointment_resource`).

## Endpoint

```
GET /api/v1/companies/:companyId/availability
    ?branchId=&serviceId=&date=YYYY-MM-DD[&employeeId=][&resourceId=]
```

`date`-ийг **салбарын цагийн бүсээр** тайлбарладаг. Хариу дахь бүх агшин нь
офсеттэй ISO мөр (`2026-09-15T09:00:00+08:00`), `timezone` талбар бүсийн нэрийг
дагалдуулна.

## Алгоритм (дараалал)

1. Салбар, үйлчилгээг шийдэх (олдохгүй/устсан/өөр компанийх → 404).
2. Үйлчилгээ `ACTIVE` биш → `SERVICE_NOT_BOOKABLE` (409).
3. Огноог салбарын календарь дээр шалгах (өнгөрсөн / хэт хол → хоосон + шалтгаан).
4. Салбарын нээлттэй цонх: `business_hours` (шөнө дамжсаныг хоёр хэсэг болгож),
   хаалтуудыг хасах. Хоосон → `BRANCH_CLOSED`.
5. Тухайн үйлчилгээний `service_availability_rule` цонхоор нарийсгах.
6. Ажилтнуудыг шүүх: үйлчилгээнд томилогдсон ∩ салбарт ажилладаг ∩ `ACTIVE` ∩
   `isBookable`. Огнооны хуваарийн онцгой тохиолдол (exception) нь давтагдах
   хуваарийг **бүхэлд нь** орлоно; завсарлага, зөвшөөрөгдсөн чөлөө, буфертэй
   захиалгуудыг хасна.
7. Нөөцийн шаардлага бүрд тухайн төрлийн идэвхтэй, захиалагдах боломжтой,
   салбарынх нөөцүүдийг цуглуулж, зөрчилтэйг хасна.
8. Слотын тор: салбарын хагас шөнөөс эхлэн `slotGranularityMin` алхмаар. Нэр
   бүрд: `appointment = [start, start+duration)`, `reserved = буфер орсон цонх`.
   Захиалга нээлттэй цонхонд бүрэн багтах ёстой; буфер цагаас хэтэрч болно.
9. Ажилтан/нөөцийн боломжийг шалгаж, тохирох бүх нэр дэвшигчийг слотод хавсаргах.

Тайлбар: N+1 байхгүй — бүх мөрийг урьдчилж ачаалаад, тооцооллыг санах ойд хийнэ
(§24). Слот тус бүрд өгөгдлийн санд хандахгүй.

## Цагийн бүсийн стратеги

- Хана-цаг (`@db.Time`) + огноо + IANA бүс → UTC агшин руу `zoned-time.ts`
  хөрвүүлнэ. `Intl` дотор Node-д суусан tzdata л цорын ганц эх сурвалж.
- **Хаврын шилжилт** (байхгүй хана-цаг): зайны хэмжээгээр урагшилна — буруу агшин
  гардаггүй.
- **Намрын шилжилт** (давхар хана-цаг): эхний (шилжилтээс өмнөх) тохиолдлыг сонгоно
  — унших үйлдэлд аюулгүй тал.
- Хөрвүүлэлт зөвхөн энэ хоёр газар: availability service ба presentation
  (`docs/DATABASE.md §16.4`).

## Нөөц ба ажилтны сонголт

Availability Engine нэр **дэвшигчдийг** буцаана, оноодоггүй. Слот бүр түүнийг
гүйцэтгэж чадах бүх ажилтан/нөөцийн жагсаалттай (эрэмбэлсэн, детерминист).
Тодорхой ажилтан/нөөцийг сонгох, түр хадгалах (hold) нь Appointment Engine-ий
ажил. Энэ үе шатанд hold систем **алга**.

## Зөрчил (conflict) шалгах

`appointment_item` ба `appointment_resource` дээрх `blocks_calendar = true`
мөрүүд л боломжийг хаана (`HOLD, PENDING, CONFIRMED, CHECKED_IN, IN_PROGRESS` →
true; `CANCELLED, NO_SHOW, COMPLETED, EXPIRED` → false — `docs/DATABASE.md §13.2`).
Давхцлыг `existingStart < candidateEnd AND existingEnd > candidateStart`
хэлбэрээр шалгана; тэнцүүгийн шалгалт байхгүй. Ижил логикийг Appointment Engine
дахин ашиглана.

## Redis кэш

Хариултын кэш нэмсэн боловч **default-оор унтраалттай**
(`AVAILABILITY_CACHE_TTL_SECONDS=0`). Түлхүүр tenant-safe
(`t:{companyId}:availability:...` — бүх параметр орсон). TTL нээвэл богино байх
ёстой: слот жагсаалт захиалга үүсмэгц хуучирна. Endpoint нь ямар ч тохиолдолд
зөвлөх шинжтэй (advisory). Redis унтарсан үед чимээгүй тооцоолол руу шилжинэ.

## Мэдэгдэж буй хязгаарлалт

- Слотын үргэлжлэх хугацаа нь үйлчилгээ/салбарын утга. Ажилтан бүрийн
  `durationOverrideMin`-ийг слотын торонд тооцдоггүй — Appointment Engine-д.
- Нэг хүсэлт = 3 гүйлгээ (branch, service, day). 1 болгож нэгтгэж болно.
- Нөөцийн бүлгүүд хооронд нэг нөөц давхардвал бүлэг тус бүрд тусад нь боломжтойд
  тооцно; бүлэг хоорондын зөрчилгүй оноолт Appointment Engine дээр.
- Өмнөх өдрийн overnight хуваарь + тухайн өдрийн exception-ий харилцан үйлчлэлийг
  зөвхөн хүссэн өдрийн exception талаас авч үзнэ.
- Шинэ `availability:read` эрхийг одоо байгаа компаниудын дүрд backfill хийх
  шаардлагатай (`pnpm db:seed` каталогид нэмнэ; OWNER-т runtime дээр бүх эрх
  олгогддог тул тэр даруй ажиллана).

## Дараагийн үе (Appointment Engine)-д зөвлөх

- `availability.engine.ts`-ийн зөрчил шалгах логик ба `interval.ts`-ийг захиалга
  үүсгэх гүйлгээнд дахин ашиглах.
- Захиалга үүсгэхдээ: tenant context тавих → availability дахин шалгах →
  `HOLD` мөр атомоор оруулах → PostgreSQL-ийн exclusion constraint шийдвэрлэнэ
  (`23P01` → `SLOT_TAKEN` 409).
- `(company_id, employee_id, date)` дээр богино түгжээ (Redis) нэмбэл зөрчлийн
  алдааг "хэн нэгэн саяхан авчихлаа" болгож зөөлрүүлнэ.
