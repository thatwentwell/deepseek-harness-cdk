# Configurar un budget para DeepSeek Harness

Esta guía crea un budget mensual de AWS Budgets que suma solo los recursos de este stack y avisa por email cuando el gasto se acerca al límite. Opcionalmente, detiene la instancia al superarlo.

El budget **no** lo crea el CDK: se configura a mano, una vez por entorno.

## Antes de empezar

### Qué cubre y qué no

Todos los recursos del stack llevan dos tags:

| Tag | Valor | Para qué |
|---|---|---|
| `app` | `deepseek-harness` | Sumar todos los entornos de DeepSeek Harness de la cuenta |
| `stack` | nombre del stack (`stackName` en `deploy.config.json`) | Un budget por entorno |

El disco EBS hereda los tags de la instancia al crearse.

**Con `llmProvider: bedrock`, el consumo del modelo también entra.** Las llamadas pasan por un *application inference profile* que lleva los mismos tags, así que los tokens de DeepSeek en Bedrock se facturan bajo `app` y `stack`. Esto requiere `bedrockInferenceProfile: true` (el valor por defecto).

**Quedan fuera del filtro por tag:**

- **El cargo por la IPv4 pública** (~3,60 USD/mes), que AWS no permite etiquetar.
- **Parte de la transferencia de datos.**
- **Los recursos del bootstrap de CDK** (bucket S3, repositorio ECR, roles).
- **Con `llmProvider: deepseek-api`, el consumo del modelo.** No es un costo de AWS; se controla desde la consola de DeepSeek.
- **Con `bedrockInferenceProfile: false`, el consumo de Bedrock.** Aparece en la factura de AWS, pero sin tags.

**Tampoco es un tope en tiempo real.** AWS actualiza los datos de Budgets hasta 3 veces por día, así que una alerta puede llegar entre 8 y 24 h después de superarse el umbral.

### Costo aproximado del stack (us-east-1, configuración por defecto)

| Recurso | USD/mes |
|---|---|
| `t4g.large` encendida 24/7 | ~49 |
| Disco gp3 de 50 GB | ~4 |
| IPv4 pública | ~3,6 |
| Secreto de Secrets Manager (solo `deepseek-api`) | 0,40 |
| NAT Gateway (solo con `privateSubnet: true`) | ~33 + tráfico |

La infraestructura suma unos **57 USD/mes** sin subred privada y unos **90 USD/mes** con subred privada.

**Con Bedrock hay que sumar los tokens**, que dependen del uso. Como referencia, el catálogo de dsh lista DeepSeek V3.2 a ~0,62 USD por millón de tokens de entrada y ~1,85 USD por millón de salida (verificá los valores actuales en la [página de precios de Bedrock](https://aws.amazon.com/bedrock/pricing/)). Un agente de código reenvía el contexto en cada paso, así que la entrada domina: por ejemplo, 5 millones de tokens de entrada y 300.000 de salida por día son unos 3,70 USD/día: unos 80 USD/mes en 22 días hábiles, o unos 110 USD si se usa todos los días.

Un punto de partida razonable es **70 USD** con la API de DeepSeek (solo infraestructura) y **150 USD** con Bedrock. Ajustalo después del primer mes con el gasto real.

### Permisos

- **Paso 1 (activar tags):** solo puede hacerlo la **cuenta de pago**. Si tu cuenta está dentro de una AWS Organization, lo hace la cuenta de gestión.
- **Pasos 2 y 3:** permisos `budgets:*` en la cuenta donde está desplegado el stack. El paso 3 además requiere crear un rol IAM.

### Variables para los comandos

Desde la carpeta del proyecto, con el stack ya desplegado:

```bash
STACK=$(jq -r .stackName deploy.config.json)
REGION=$(jq -r .region deploy.config.json)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

Para comprobar que los recursos tienen los tags:

```bash
aws resourcegroupstaggingapi get-resources --region "$REGION" --tag-filters Key=stack,Values="$STACK" --query 'ResourceTagMappingList[].ResourceARN' --output table
```

Deberías ver la instancia, el volumen, el secreto, la VPC, las subredes y el security group.

## Paso 1: activar los tags de asignación de costos

AWS no usa un tag en Billing ni en Budgets hasta que se lo activa como *cost allocation tag*. Hay que tener en cuenta dos demoras:

- La clave del tag aparece en la lista recién cuando un recurso que la usa generó costos, **hasta 24 h después del primer deploy**.
- Después de activarla, los datos tardan **hasta 24 h más**, y la activación no es retroactiva: solo cuenta el gasto desde ese momento.

### Desde la consola

1. Abrí **Billing and Cost Management → Cost allocation tags**.
2. En la pestaña **User-defined cost allocation tags**, buscá `app` y `stack`.
3. Seleccioná ambas y elegí **Activate**.

### Desde la CLI

```bash
aws ce list-cost-allocation-tags --region us-east-1 --tag-keys app stack
```

```bash
aws ce update-cost-allocation-tags-status --region us-east-1 --cost-allocation-tags-status TagKey=app,Status=Active TagKey=stack,Status=Active
```

Si la primera consulta no devuelve las claves, todavía no pasaron las 24 h desde el deploy: esperá y reintentá. Cost Explorer usa siempre el endpoint de `us-east-1`, sin importar dónde esté el stack.

## Paso 2: crear el budget con alertas

Podés crear el budget antes de que terminen de propagarse los tags: va a marcar 0 hasta que lleguen los datos.

El budget propuesto envía dos alertas:

- **Real > 80 %:** el gasto del mes ya superó el 80 % del límite.
- **Pronóstico > 100 %:** al ritmo actual, el mes va a cerrar por encima del límite.

### Desde la consola

1. Abrí **Billing and Cost Management → Budgets → Create budget**.
2. Elegí **Customize (advanced)** y **Cost budget**.
3. Nombre: `deepseek-harness-<stackName>`. Período **Monthly**, tipo **Recurring budget**, método **Fixed** y el monto elegido.
4. En **Budget scope**, elegí **Filter specific AWS cost dimensions**. Agregá el filtro **Tag**, clave `stack` y valor = tu `stackName`.
5. Agregá dos alertas:
   - **Actual**, umbral 80 % del monto presupuestado, con tu email.
   - **Forecasted**, umbral 100 %, con tu email.
6. Revisá y elegí **Create budget**.

Los avisos por email no requieren confirmar la suscripción.

### Desde la CLI

Definí el monto y el email:

```bash
AMOUNT=70
EMAIL=tu-email@ejemplo.com
```

Generá el archivo del budget:

```bash
jq -n --arg name "deepseek-harness-$STACK" --arg amount "$AMOUNT" --arg tag "user:stack\$$STACK" '{BudgetName: $name, BudgetLimit: {Amount: $amount, Unit: "USD"}, BudgetType: "COST", TimeUnit: "MONTHLY", CostFilters: {TagKeyValue: [$tag]}}' > budget.json
```

Generá el archivo de alertas:

```bash
jq -n --arg email "$EMAIL" '[{type: "ACTUAL", pct: 80}, {type: "FORECASTED", pct: 100}] | map({Notification: {NotificationType: .type, ComparisonOperator: "GREATER_THAN", Threshold: .pct, ThresholdType: "PERCENTAGE"}, Subscribers: [{SubscriptionType: "EMAIL", Address: $email}]})' > notifications.json
```

Creá el budget:

```bash
aws budgets create-budget --account-id "$ACCOUNT" --budget file://budget.json --notifications-with-subscribers file://notifications.json
```

El filtro tiene el formato `user:<clave>$<valor>`. Por ejemplo, `user:stack$DeepseekHarness`. Para un budget que sume **todos** los entornos, usá `user:app$deepseek-harness`.

Comprobá que se creó:

```bash
aws budgets describe-budget --account-id "$ACCOUNT" --budget-name "deepseek-harness-$STACK"
```

Los archivos `budget.json` y `notifications.json` ya no hacen falta; borralos o no los subas al repositorio (el segundo contiene tu email).

## Paso 3 (opcional): detener la instancia al superar el límite

Una *budget action* puede detener la instancia EC2 automáticamente cuando el gasto real supera el 100 %. La instancia queda **detenida, no borrada**, y el workspace en disco se conserva. El disco y la IPv4 pública siguen generando costos mientras tanto (unos 8 USD/mes).

### 1. Crear el rol que usa Budgets

```bash
aws iam create-role --role-name DeepseekHarnessBudgetsAction --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"budgets.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
```

```bash
aws iam attach-role-policy --role-name DeepseekHarnessBudgetsAction --policy-arn arn:aws:iam::aws:policy/AWSBudgetsActions_RolePolicyForResourceAdministrationWithSSM
```

### 2. Obtener el ID de la instancia

```bash
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text
```

### 3. Agregar la acción desde la consola

1. En **Budgets**, abrí `deepseek-harness-<stackName>` y elegí **Actions → Add action**.
2. Rol IAM: `DeepseekHarnessBudgetsAction`.
3. Tipo de acción: **Automate Instances to stop for EC2 or RDS**. Elegí la región del stack y el ID de instancia del punto anterior.
4. Umbral: **100 %** del monto, tipo **Actual**.
5. En **Do you want to automatically run this action?**, elegí **Yes** para que actúe sola, o **No** para recibir un email y aprobarla a mano.
6. Agregá tu email en **Configure alerts** y guardá.

Para volver a encender la instancia después de revisar el gasto:

```bash
aws ec2 start-instances --region "$REGION" --instance-ids <InstanceId>
```

Al arrancar, el servicio `dsh-web` genera un token nuevo; `scripts/connect.sh` muestra la URL actualizada.

Los budgets solo con alertas son gratis. Los budgets con acciones son gratis hasta dos por cuenta; a partir del tercero, cada uno cuesta 0,10 USD por día.

## Mantenimiento

- **Si cambiás el tipo de instancia o la región**, revisá el monto del budget.
- **Si cambiás el `stackName` o desplegás en otra región con otro nombre**, el budget anterior deja de ver el nuevo stack: creá uno nuevo con el valor actualizado.
- **Si recreás la instancia** (por ejemplo, después de un `cdk destroy` y un nuevo deploy), cambia el ID de instancia: actualizá la acción del paso 3.
- **Al borrar el entorno**, borrá también el budget:

```bash
aws budgets delete-budget --account-id "$ACCOUNT" --budget-name "deepseek-harness-$STACK"
```
