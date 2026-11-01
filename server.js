const app = require('./app');
const { startScheduler } = require('./lib/scheduler');

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`ParcelHub running at http://localhost:${port}`);
  startScheduler();
});
