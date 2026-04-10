# ioBroker.life360

![Logo](admin/Life360_xl.svg)



![Number of Installations](https://iobroker.live/badges/iobroker.life360.svg) ![Current version in stable repository](https://iobroker.live/badges/life360-stable.svg)
[![NPM Version](https://nodei.co/npm/iobroker.autodarts.svg?style=shields&data=v,u,d&color=orange)](https://www.npmjs.com/package/iobroker.life360)
[![Downloads](https://img.shields.io/npm/dm/iobroker.life360.svg)](https://www.npmjs.com/package/iobroker.life360)

[![Paypal Donation](https://img.shields.io/badge/paypal-donate%20|%20spenden-green.svg)](https://www.paypal.com/donate/?hosted_button_id=7W6M3TFZ4W9LW)

## Life360 adapter for ioBroker

An ioBroker adapter for [Life360](https://www.life360.com).

## Description

This adapter connects to the [Life360](https://www.life360.com) cloud services to allow you to track people and to detect their presence at defined places. It retrieves information about the user's circles, the circles' members and the circles' places. These information persists the adapter in ioBroker states. Any states will get updated in a given interval.

## Installation

Right now you'll have to add the adapter to your ioBroker using a custom URL pointing to the corresponding [GitHub](https://github.com/) repository at https://github.com/inventwo/ioBroker.life360/tree/master .

### Install the Node JS package on the command line

If you don't want to install the adapter using the web UI or if you want to install a special version, including development version, you can do so on the command line.

1. Login to your ioBroker host
2. Switch to ioBroker's installation directory (defaults to `/opt/iobroker`)
3. Run the following commands

    ``` bash
    iobroker npm install inventwo/iobroker.life360 --loglevel error --prefix "/opt/iobroker"
    ```

4. Add an instance using the web UI

If you want to install the development version just type ...

``` bash
iobroker npm install inventwo/iobroker.life360#develop --loglevel error --prefix "/opt/iobroker"
```

## Configuration

### Life360 cloud services

You'll have to setup the adapter with your personal [Life360](https://www.life360.com) credentials to let the adapter poll the information from the cloud services. You can login with your mobile phone number or your email-address (recommended) for Life360, but in any case you'll have to set the password to your personal Life360 password.

![Logo](admin/ioBroker.life360.settings.life360.png)

- Either enter your email address **OR** your country code and mobile phone number. **Do NOT enter email address and mobile phone information !**

- Feel free to modify the default timespan of 60 seconds for the polling interval. The polling interval must be 15 seconds or more.

### My Places

You can add your own places apart from the Life360 places to your adapter instance. "My Places" let you define private places that are not public to the Life360 cloud services. The adapter checks which persons are present at your private places on every Life360 data poll.

![Logo](admin/ioBroker.life360.settings.myplaces.png)

The places' setup happens the same way as with the Places-adapter:

- Define a ```Name``` for the place.

- Set the geo-position data for the place (latitude and longitude).

- Set the place's radius in meters.

#### Why should I use My Places apart from Life360 places?

- My Places are private! Life360 will not know about them.

- People can be present at more than one place at the same point of time. For example you can be present at your "home" place and your "neighborhood" place at the same time.

- You can set the place's radius without any limitations (minimum value).

### Integration

The Life360 cloud services provide a lot of information about the circles, places and people. You have the freedom of choice. You device which data will be available to your ioBroker installation.

![Logo](admin/ioBroker.life360.settings.integration.png)

#### Life360 data

Select the Life360 data you want the adapter to push to ioBroker data points.

- Enable processing of ```Life360 circles``` for information regarding the circles, the circles' places and the circles' members. You will get a lot of information regarding the circles, but only essential information about places and people.

- Enable processing of ```Life360 places``` for detailed information regarding any Life360 circle, you are a member of.

- Enable processing of ```Life360 people``` for detailed information about any Life360 person, who are members of the circles you are a member of.

#### Send location data to Places-adapter

The ioBroker.life360 adapter let you send location data for known Life360 people to an instance of the Places-adapter.

- Select an instance of the Places-adapter as a receiver for the location data. Select ```None``` to disable sending of location data.

- You can include or exclude people using regular expression patterns. The adapter will check if the string ```[Firstname] [Lastname]``` matches your pattern. Set pattern to empty string to disable regex filtering.

#### Location-Tracking

You can activate location-tracking for all people. Location-tracking will add geo-positioning details to the people information.

- Check to activate location-tracking.

- Set the geo-location object-type to push combined latitude and longitude values.

## Disclaimer

I did not find any official documentation for the [Life360](https://www.life360.com) REST APIs. Apparently [Life360](https://www.life360.com) does not support the use of the REST API for other applications than its own ones.

My REST API integration is based on reverse engineering done by the open source community and an API token discovered on [Life360](https://www.life360.com) code which is public available. [Life360](https://www.life360.com) could disable or modify this API token or change its REST API in a way that this adapter will not work as expected anymore.

Feel free to modify the default timespan of 60 seconds for the polling interval. The adapter does not allow modifying the interval to less than 15 seconds to prevent gaining any rate limits and to prevent ioBroker Admin getting slower and slower.

## Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->
### 1.0.0 (2026-04-10)

- (skvarel) Transfer to inventwo organization
- (skvarel) Updated dependencies to current versions

## Older changes
- [CHANGELOG_OLD.md](CHANGELOG_OLD.md)

## License
MIT License

Copyright (c) 2026 skvarel <sk@inventwo.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
