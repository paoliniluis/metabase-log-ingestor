import {serve} from 'bun';
import postgres from 'postgres';

if (process.env['POSTGRES_CONN_STRING'] && process.env['CREATE_METRICS_TABLE'] === 'true') {
  const sql = postgres(`${process.env['POSTGRES_CONN_STRING']}`);

  await sql`DROP TABLE IF EXISTS metrics`;
  await sql`CREATE TABLE IF NOT EXISTS metrics (
    id SERIAL PRIMARY KEY,
    source varchar(100),
    version varchar(50),
    verb varchar(5),
    endpoint TEXT,
    is_async BOOLEAN,
    async_completed varchar(5),
    code INTEGER,
    time DECIMAL(10,2),
    timeunit TEXT,
    time_in_ms DECIMAL(10,2),
    app_db_calls INTEGER,
    app_db_conns INTEGER,
    total_app_db_conns INTEGER,
    jetty_threads INTEGER,
    total_jetty_threads INTEGER,
    jetty_idle INTEGER,
    active_threads INTEGER,
    queries_in_flight INTEGER,
    queued INTEGER,
    dw_id varchar(255),
    dw_db_connections INTEGER,
    dw_db_total_conns INTEGER,
    threads_blocked INTEGER
  )`;
}

serve({
  async fetch(request) {
  
    const body = await request.json();
    let fullMessage = ''
    let fullTail = ''

    if (request.method === 'POST' && request.url.includes('logs')) {
      if (process.env['LOKI_HOST']) {
        if (body.exception && body.mdc) {
          fullMessage = body.message + '\n' + body.exception.stacktrace
          fullTail = {
            trace_id: body.mdc.traceid,
            span_id: body.mdc.span_id,
            traceparent: request.headers.traceparent,
            exception: body.exception.exception_class
          }
        } else if (body.mdc) {
          fullMessage = body.message
          fullTail = {
            trace_id: body.mdc.traceid,
            span_id: body.mdc.span_id,
            traceparent: request.headers.traceparent,
          }
        } else {
          fullMessage = body.message
          fullTail = {
            traceparent: request.headers.traceparent,
          }
        }

        let reqMessage = {
          streams: [
            {
              stream: {
                source: body.source_host,
                service_name: 'metabase',
                level: body.level,
                logger: body.logger_name,
              },
              values: [
                  [ body.timestamp.toString(), fullMessage, fullTail ],
              ]
            }
          ]
        }

        const response = await fetch(process.env['LOKI_HOST'], {
          method: "POST",
          body: JSON.stringify(reqMessage),
          headers: { "Content-Type": "application/json" },
        });

        return new Response({status: 200});
      } else if (process.env['INFLUX_ENDPOINT'] || process.env['POSTGRES_CONN_STRING']) {

        let values = {};

        values.version = process.env['VERSION'] || 'vUNKNOWN';
        values.source = process.env['SOURCE'] || request.headers.get('host');

        let positions = {};

        if (body.message.includes('GET') || body.message.includes('POST') || body.message.includes('PUT') || body.message.includes('DELETE')) {
          let logline = body.message.split(' ');
          values.verb = logline[0];
          values.verb = values.verb.includes('m') ? values.verb.substring(values.verb.indexOf('m')+1, values.verb.length) : values.verb;
          values.endpoint = logline[1];
          values.is_async = body.message.includes('async') ? true : false;
          values.async_completed = values.is_async ? logline[4].substring(0, logline[4].length-1) : "";
          values.code = logline[2] != '' ? parseInt(logline[2]) : '';
          
          positions = {
            time: 3,
            timeunit: 4,
            app_db_calls: 5,
            app_db_conns: 11,
            total_app_db_conns: 11,
            jetty_threads: 14,
            total_jetty_threads: 14,
            jetty_idle: 15,
            active_threads: 19,
            queries_in_flight: 26,
            queued: 27,
            dw_id: 29,
            dw_db_connections: 31,
            dw_db_total_conns: 33,
            threads_blocked: 34
          }

          if (values.code === 202) {
            positions = Object.fromEntries(Object.entries(positions).map(([key, value]) => [key, value + 2]));
            positions.dw_db_connections += 2;
          }

          if (values.endpoint.includes('tiles')) {
            positions.dw_db_connections += 2;
          }

          // function to transform any time unit into milliseconds
          const transformTimeIntoMs = (timeunit, time) => {
            switch (timeunit) {
              case 'µs':
                return time / 1000;
              case 'ms':
                return time;
              case 's':
                return time * 1000;
              case 'm':
                return time * 60000;
              default:
                return time;
            }
          }

          values.time = logline[positions.time];
          values.timeunit = logline[positions.timeunit];
          values.time_in_ms = transformTimeIntoMs(values.timeunit, values.time);
          values.app_db_calls = logline[positions.app_db_calls].replace('(','');
          values.app_db_conns = logline[positions.app_db_conns]?.substring(0, logline[positions.app_db_conns].indexOf('/'));
          values.total_app_db_conns = logline[positions.total_app_db_conns]?.substring(logline[positions.total_app_db_conns].indexOf('/')+1, logline[positions.total_app_db_conns].length);
          values.jetty_threads = logline[positions.jetty_threads]?.substring(0, logline[positions.jetty_threads].indexOf('/'));
          values.total_jetty_threads = logline[positions.total_jetty_threads]?.substring(logline[positions.total_jetty_threads].indexOf('/')+1, logline[positions.total_jetty_threads].length);
          values.jetty_idle = logline[positions.jetty_idle]?.replace("(", "");
          values.jetty_queued = logline[positions.queued]?.replace("(", "");;
          values.active_threads = logline[positions.active_threads]?.replace("(", "");
          values.queries_in_flight = logline[positions.queries_in_flight];
          values.queued = logline[positions.queued]?.replace("(", "");
          values.dw_id = logline[positions.dw_id]?.concat("_").concat(logline[positions.dw_id+2]);
          values.dw_db_connections = logline[positions.dw_db_connections]?.substring(0, logline[positions.dw_db_connections].indexOf('/'));
          values.dw_db_total_conns = logline[positions.dw_db_total_conns]?.substring(logline[positions.dw_db_total_conns].indexOf('/')+1, logline[positions.dw_db_total_conns].length);
          values.threads_blocked = logline[positions.threads_blocked]?.replace("(", "");

          if (process.env['INFLUX_ENDPOINT']) {

            let tags = `version=${values.version},source=${values.source}`
            
            let influxValues = `verb="${values.verb}",endpoint="${values.endpoint}",is_async="${values.is_async}",async_completed="${values.async_completed}",code=${values.code},time=${values.time},timeunit="${values.timeunit}",time_in_ms=${values.time_in_ms}`

            values.app_db_calls ? influxValues += `,app_db_calls=${values.app_db_calls}` : '';
            values.app_db_conns ? influxValues += `,app_db_conns=${values.app_db_conns}` : '';
            values.total_app_db_conns ? influxValues += `,total_app_db_conns=${values.total_app_db_conns}` : '';
            values.jetty_threads ? influxValues += `,jetty_threads=${values.jetty_threads}` : '';
            values.total_jetty_threads ? influxValues += `,total_jetty_threads=${values.total_jetty_threads}` : '';
            values.jetty_idle ? influxValues += `,jetty_idle=${values.jetty_idle}` : '';
            values.active_threads ? influxValues += `,active_threads=${values.active_threads}` : '';
            values.queries_in_flight ? influxValues += `,queries_in_flight=${values.queries_in_flight}` : '';
            values.queued ? influxValues += `,queued=${values.queued}` : '';
            values.dw_id ? influxValues += `,dw_id="${values.dw_id}"` : '';
            values.dw_db_connections ? influxValues += `,dw_db_connections=${values.dw_db_connections}` : '';
            values.dw_db_total_conns ? influxValues += `,dw_db_total_conns=${values.dw_db_total_conns}` : '';
            values.threads_blocked ? influxValues += `,threads_blocked=${values.threads_blocked}` : '';

            let ts = new Date().getTime();

            let line = `metrics,${tags} ${influxValues} ${ts}`;
            
            await fetch(`${process.env['INFLUX_ENDPOINT']}/api/v2/write?org=${process.env['INFLUX_ORG']}&bucket=${process.env['INFLUX_BUCKET']}&precision=ms`, {
              method: "POST",
              body: line,
              headers: { 
                "Authorization": `Token ${process.env['INFLUX_TOKEN']}`,
                "Content-Type": "text/plain; charset=utf-8",
                "Accept": "application/json"
              },
            });
          };
          
          if (process.env['POSTGRES_CONN_STRING']) {
            const sql = postgres(`${process.env['POSTGRES_CONN_STRING']}`, {
              transform: {
                ...postgres.camel,
                undefined: null
              }
            });
            
            await sql`INSERT INTO metrics 
            ${sql(values,
              'source', 
              'version',
              'verb', 
              'endpoint',
              'is_async',
              'async_completed',
              'code',
              'time',
              'timeunit',
              'time_in_ms',
              'app_db_calls',
              'app_db_conns',
              'total_app_db_conns',
              'jetty_threads',
              'total_jetty_threads',
              'jetty_idle',
              'active_threads',
              'queries_in_flight',
              'queued',
              'dw_id',
              'dw_db_connections',
              'dw_db_total_conns',
              'threads_blocked')}`;
          }
        }
        return new Response({status: 200});
      }
    }
  }
})