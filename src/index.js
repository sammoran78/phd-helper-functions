require('./functions/references');
require('./functions/analyze');
require('./functions/upload');
require('./functions/calendar');
require('./functions/drive');
require('./functions/newsreader');
require('./functions/analytics');
require('./functions/surveys');
require('./functions/projects');
require('./functions/ai');
if (process.env.ENABLE_KB_PIPELINE === '1') {
    require('./functions/kb-pipeline');
}
