# Growith: anuncios de lanzamiento (27/oct/2026)

## Cómo están ordenados

En `LISTAS_PARA_SUBIR/`, **cada anuncio sale en dos medidas con el mismo nombre**, que solo cambia al final:

```
01_TOFU_ticket-ganancia_271026_FEED-4x5.png        → feed, 1080 × 1350
01_TOFU_ticket-ganancia_271026_HISTORIA-9x16.png   → historias y reels, 1080 × 1920
```

Ordenadas por nombre, las dos medidas de un anuncio quedan una al lado de la otra. En Meta, al crear el anuncio, se eligen las dos juntas con el mismo número: la FEED va en "Feeds" y la HISTORIA en "Stories y Reels" (personalizar el contenido por ubicación).

- **Número:** el del anuncio, del 01 al 12. Usalo también como nombre del anuncio en Meta y en `utm_content`.
- **Etapa:** TOFU = público frío · MOFU = tibio, un dolor puntual · BOFU = caliente, remarketing.
- **Para regenerar todo** (limpia la carpeta, arma los 24 PNG y la hoja de contacto con los pares): `python3 armar_todo.py`. Los números que se repiten están en `comun.py` → `DATOS` y son los mismos de la landing.

**Link de destino:** `https://www.growithapp.com/?utm_source=meta&utm_medium=paid&utm_campaign=lanzamiento_oct26&utm_content=<número>`. La landing acepta `utm_*` y `fbclid` sin salirse de la portada.

Las cifras de las placas son de ejemplo y lo dicen ("datos de ejemplo"). No se promete nada que hoy esté apagado: ni publicar ni pausar campañas, ni TikTok, ni Shopify en un clic.

## Los 12 anuncios

| # | Concepto | Fondo | Etapa | Título | Texto principal | Descripción |
|---|---|---|---|---|---|---|
| 01 | Ticket de ganancia | Oscuro | TOFU | Vendiste $ 58.900. ¿Cuánto te quedó? | Tu tienda te dice cuánto facturaste. Growith te dice cuánto te quedó: le resta a cada venta el costo del producto, la comisión REAL de Mercado Pago, el envío y la publicidad que le corresponde. Para Tienda Nube, Shopify y Mercado Libre. | 14 días gratis · sin tarjeta |
| 02 | Facturar no es ganar | Oscuro | TOFU | Facturar no es ganar | Este mes facturaste millones. ¿Cuánto es ganancia de verdad? Growith junta tus ventas de todos los canales y descuenta mercadería, comisiones, envíos y publicidad. Ves tu margen real por venta, por producto y por mes. | Probalo gratis 14 días |
| 03 | Ocho pestañas | Oscuro | TOFU | Cerrá ocho pestañas. Abrí una. | Admin de la tienda, Mercado Libre, el portal de Andreani, ARCA, el administrador de anuncios y tres planillas. Growith lo junta en un solo lugar y te dice qué resolver primero cada mañana. | Hecho para e-commerce argentinos |
| 04 | Etiquetas de Andreani | Oscuro | MOFU | Etiquetas de Andreani sin contrato propio | Cargás saldo con Mercado Pago o transferencia y emitís las etiquetas desde tus pedidos. Ves el precio antes de emitir, salen con el SKU impreso para imprimir en tanda, y si te equivocás la anulás en 30 minutos y el saldo vuelve. | 14 días gratis · sin tarjeta |
| 05 | ARCA 23/23 | Oscuro | MOFU | Tus ventas se facturan solas | Growith toma las ventas de tu tienda y de Mercado Libre y emite la factura en ARCA con CAE, PDF y QR. Monotributo o Responsable Inscripto, varios CUITs y puntos de venta. Sin copiar un solo dato. | Desde USD 19 por mes |
| 06 | IA conectada | Oscuro | MOFU | Preguntale por tu negocio a tu IA | Conectá Growith a Claude, ChatGPT o Gemini y preguntá qué producto te deja más ganancia, cómo vienen los envíos o qué se está por agotar. Solo lee tus datos: no cambia nada. | Probalo gratis 14 días |
| 07 | 14 días gratis | Oscuro | BOFU | 14 días gratis, con todo | Ganancia real por venta, etiquetas de Andreani con saldo, facturación en ARCA, stock de todos tus canales, reclamos y Mercado Libre en un solo lugar. Sin tarjeta y sin permanencia. Después, desde USD 19 por mes. | En marcha en 5 minutos |
| 08 | El alquiler vence mañana | Blanco | MOFU | Growith te avisa antes de que venza | Alquiler, proveedores, préstamos, cuotas y tarjetas en un Calendario de pagos que te manda un mail el día anterior y el día del vencimiento. Junto con las ventas, los envíos y la facturación de tu tienda. | 14 días gratis · sin tarjeta |
| 09 | Comisión real de Mercado Pago | Violeta | TOFU | No es "más o menos el 7 %" | Cada venta te cuesta una comisión distinta: en un pago, en cuotas sin interés, con promo. Growith lee lo que de verdad te cobró Mercado Pago en cada venta y te muestra cuánto te quedó. | Tu ganancia real, venta por venta |
| 10 | Stock: le quedan 4 días | Gris claro | MOFU | Te enterás antes de que se agote | Growith suma el stock de Tienda Nube, Shopify y Mercado Libre y te avisa cuando a un producto le quedan pocos días al ritmo de venta actual. | Probalo gratis 14 días |
| 11 | Reclamos: el mensaje ya escrito | Blanco | MOFU | Ningún cambio se pierde | Cada reclamo, cambio o devolución te dice qué hacer ahora y te deja el mensaje para el cliente listo para mandar por WhatsApp o mail. También los reclamos de Mercado Libre. | 14 días gratis · sin tarjeta |
| 12 | Un día con Growith | Lavanda | TOFU | Todo tu día de trabajo, en una pantalla | Ves lo pendiente, mirás la ganancia de ayer, emitís las etiquetas de Andreani, las ventas se facturan solas en ARCA y te enterás qué reponer. Con Tienda Nube, Shopify y Mercado Libre conectados. | En marcha en 5 minutos |

## Cómo armar las campañas

- **Frío (TOFU: 01, 02, 03, 09, 12):** público amplio con interés en e-commerce, Tienda Nube o Mercado Libre.
- **Tibio (MOFU: 04, 05, 06, 08, 10, 11):** cada anuncio prueba un dolor puntual, así se ve cuál engancha más.
- **Caliente (BOFU: 07):** remarketing de quienes visitaron la landing.
- Mezclar fondo oscuro y claro en el mismo conjunto de anuncios ayuda a que Meta no muestre siempre el mismo estilo.

**Antes de pautar** (pospuesto el 27/oct, recordatorio el 3/nov): falta el píxel de Meta y la API de conversiones. Sin eso, Meta no puede optimizar por registros y el remarketing del 07 no tiene público.
