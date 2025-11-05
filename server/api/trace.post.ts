/* import formidable from 'formidable';
import fs from 'fs';
import { Potrace } from 'potrace';

export default defineEventHandler(async (event) => {
    if (event.req.method !== 'POST') {
        event.res.statusCode = 405;
        return 'Method Not Allowed';
    }

    const form = formidable({ multiples: false });
    return new Promise((resolve, reject) => {
        form.parse(event.req, (err, fields, files) => {
            if (err || !files.image) {
                event.res.statusCode = 400;
                resolve('No image uploaded');
                return;
            }
            const imagePath = files.image.filepath || files.image.path;
            Potrace.trace(imagePath, { color: '#000000' }, (err, svg) => {
                if (err) {
                    event.res.statusCode = 500;
                    resolve('SVG conversion failed');
                    return;
                }
                event.res.setHeader('Content-Type', 'image/svg+xml');
                resolve(svg);
            });
        });
    });
});
 */
