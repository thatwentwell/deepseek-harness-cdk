# DeepSeek Harness en AWS (CDK)

Despliega [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`) en una instancia EC2, accesible solo a través de SSM Session Manager.

## Arquitectura

```
tu navegador ──► localhost:3080 ──(túnel SSM)──► EC2 (Amazon Linux 2023)
                                                  └─ systemd: dsh-web
                                                     dsh --profile web --host 127.0.0.1
                                                     usuario "dsh", workspace /home/dsh/workspace
```

- **Sin puertos de entrada.** `dsh web` solo escucha en loopback y rechaza `0.0.0.0` a propósito, porque el agente ejecuta comandos en la máquina. El acceso es por port forwarding de SSM, sin SSH, sin IP expuesta y sin balanceador.
- **API key en Secrets Manager.** Se lee en cada arranque del servicio y no queda en la plantilla ni en la user data.
- **Aislamiento del agente.** Corre como el usuario sin privilegios `dsh`. Por defecto, una regla de iptables le bloquea el acceso al servicio de metadatos (IMDS), así que los comandos que ejecute el agente no pueden usar las credenciales del rol de la instancia.
- **Autenticación de la UI.** `dsh` imprime al arrancar una URL con un token de proceso. `scripts/connect.sh` la recupera del journal por SSM.
- La instancia exige IMDSv2 y usa un disco gp3 cifrado. El despliegue espera a que termine el aprovisionamiento (cfn-signal) y falla si algo sale mal.

## Requisitos

- Node.js 22+, AWS CLI v2 con credenciales y `jq`
- [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) para el túnel

## Uso

```bash
npm install
npm run deploy              # menú: región, tipo de instancia y opciones avanzadas
scripts/set-api-key.sh      # pide la DEEPSEEK_API_KEY, la guarda y reinicia el servicio
scripts/connect.sh          # abre el túnel e imprime la URL con token
```

`npm run deploy` hace lo siguiente:

1. Valida las credenciales de AWS y muestra la cuenta de destino.
2. Pide la región (solo las habilitadas en la cuenta) y el tipo de instancia (solo los disponibles en esa región, con vCPU, memoria y arquitectura). Opcionalmente, nombre del stack, disco y subred privada.
3. Verifica el destino. Ofrece hacer el `cdk bootstrap` si la región no lo tiene, avisa si ya hay un stack desplegado en otra región y avisa si cambiar el tipo de instancia la va a reiniciar.
4. Muestra un resumen y, recién al confirmar, escribe `deploy.config.json` y ejecuta `cdk deploy`. Si cancelás antes, no se guarda nada.
5. Al terminar, muestra la configuración, los outputs del stack y los próximos pasos.

Abrí la URL que imprime `connect.sh` (`http://127.0.0.1:3080/...`) mientras el túnel esté abierto.

## Configuración (`deploy.config.json`)

El archivo no existe hasta que corrés `npm run deploy` (está en `.gitignore`). Para armarlo a mano, copiá la plantilla:

```bash
cp deploy.config.json.example deploy.config.json
```

Para ver la configuración guardada en cualquier momento:

```bash
npm run show-config
```

| Clave | Por defecto | Descripción |
|---|---|---|
| `region` | — | Región de AWS del stack |
| `stackName` | `DeepseekHarness` | Nombre del stack |
| `instanceType` | `t4g.large` | Graviton o x86; la AMI se elige según la arquitectura |
| `volumeSizeGiB` | `50` | Disco raíz (workspace y `~/.dsh`) |
| `privateSubnet` | `false` | `true`: subred privada + NAT Gateway (~32 USD/mes extra) |
| `dshVersion` | `0.2.0-rc.2` | Versión de `@deepseek-ai/dsh` |
| `nodeMajor` | `22` | Versión mayor de Node.js |
| `webPort` | `3080` | Puerto de la UI (en loopback y en el túnel local) |
| `blockImdsForAgent` | `true` | `false` si querés que el agente use el rol de la instancia |
| `vpcId` | `""` | (opcional) VPC existente |
| `existingSecretArn` | `""` | (opcional) Secreto existente con la API key |

Después de editar el archivo a mano, volvé a ejecutar `npm run deploy` (el menú propone los valores guardados) o `npx cdk deploy` (sin menú). Un `-c clave=valor` en la línea de comandos tiene prioridad sobre el archivo, por ejemplo `npx cdk deploy -c instanceType=m7g.xlarge`. Todos los comandos de `cdk` (`synth`, `diff`, `destroy`) y los scripts `set-api-key.sh` y `connect.sh` usan la región y el stack de este archivo, y fallan con un mensaje claro si no existe o le faltan parámetros.

## Operación

```bash
# Shell en la instancia
aws ssm start-session --region <región> --target <InstanceId>
# Logs del servicio / del aprovisionamiento
sudo journalctl -u dsh-web -f
sudo cat /var/log/dsh-bootstrap.log
# Actualizar dsh en caliente
sudo /opt/node/bin/npm install -g @deepseek-ai/dsh@<versión> && sudo systemctl restart dsh-web
```

Para darle repos al agente, clónalos en `/home/dsh/workspace` (como usuario `dsh`).

## Notas

- Cambiar `dshVersion` en el archivo **no** actualiza una instancia ya creada (la user data solo corre al crearla, para no perder el workspace). Actualizá por SSM como se indica arriba.
- `cdk destroy` borra la instancia **y su disco**. Haz backup del workspace (snapshot de EBS) antes.
- El secreto creado por el stack se borra con `cdk destroy`. Si usas `existingSecretArn`, ese secreto no se toca.
- **Costos:** todos los recursos llevan los tags `app=deepseek-harness` y `stack=<stackName>`, y el disco los hereda de la instancia. Para crear un budget con alertas (y opcionalmente detener la instancia al superarlo), seguí [doc/budgets.md](doc/budgets.md).
- DeepSeek Harness está en *developer preview*. Fija la versión y prueba antes de actualizar.
