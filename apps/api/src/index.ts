import { createApp, bootstrap } from './app';
import { config } from './config';
import { startJobs } from './jobs';

bootstrap();
const app = createApp();
startJobs();
app.listen(config.port, () => {
  console.log(`${config.appName} API listening on http://localhost:${config.port} (${config.env})`);
  console.log(`Web app: ${config.webUrl}  Admin: ${config.adminUrl}`);
});
