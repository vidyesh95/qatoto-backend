import express from "express";
import type { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import logger from "morgan";
import cookieParser from "cookie-parser";
import createError from "http-errors";

import indexRouter from "#src/routes/index.js";
import usersRouter from "#src/routes/users.js";

const app = express();

app.use(helmet());
app.use(cors());
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use('/', indexRouter);
app.use('/users', usersRouter);

/** 
 * catch 404 and forward to error handler 
 */
app.use((req: Request, res: Response, next: NextFunction) => {
    next(createError(404));
});

/** 
 * error handler 
 */
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    // set locals, only providing error in development
    const error = req.app.get('env') === 'development' ? err : {};

    // set the statuscode (default to 500)
    const statusCode = err.status || 500;

    // render the error page
    res.status(statusCode).json({
        message: err.message,
        error: error
    });
});

export default app;
